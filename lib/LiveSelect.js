"use strict";

var _prototypeProperties = function (child, staticProps, instanceProps) { if (staticProps) Object.defineProperties(child, staticProps); if (instanceProps) Object.defineProperties(child.prototype, instanceProps); };

var _inherits = function (subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) subClass.__proto__ = superClass; };

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

var EventEmitter = require("events").EventEmitter;
var _ = require("lodash");

var murmurHash = require("../dist/murmurhash3_gc");
var querySequence = require("./querySequence");
var cachedQueries = {};

// Minimum duration in milliseconds between refreshing results
// TODO: determine based on load
//  https://git.focus-sis.com/beng/pg-notify-trigger/issues/6
var THROTTLE_INTERVAL = 200;
// Number of potential refresh conditions before ignoring THROTTLE_INTERVAL
//  and refreshing immediately in order to avoid call stack overrun
var MAX_CONDITIONS = 3500;
// Specify prefix for aliased columns in result set to a string that
//  starts with underscore or letter and is unique from any column prefix
//  existing in the schema
var ALIAS_PREFIX = "_0";
// Specify "_id" meta column to avoid conflicts
var ID_ALIAS = "_id";

var LiveSelect = (function (EventEmitter) {
  function LiveSelect(parent, query, params) {
    var _this = this;
    _classCallCheck(this, LiveSelect);

    var client = parent.client;
    var channel = parent.channel;


    this.params = params || [];
    this.client = client;
    this.data = {};
    this.ready = false;

    // throttledRefresh method buffers
    this.refreshQueue = [];
    this.throttledRefresh = _.debounce(this.refresh, THROTTLE_INTERVAL);

    // Create view for this query
    addHelpers.call(this, query, function (error, result) {
      if (error) return _this.emit("error", error);

      var triggers = {};
      var aliases = {};
      var primary_keys = result.keys;

      result.columns.forEach(function (col) {
        if (!triggers[col.table]) {
          triggers[col.table] = [];
        }

        if (!aliases[col.table]) {
          aliases[col.table] = {};
        }

        triggers[col.table].push(col.name);
        aliases[col.table][col.name] = col.alias;
      });

      _this.triggers = _.map(triggers, function (columns, table) {
        return parent.createTrigger(table, columns);
      });

      _this.aliases = aliases;
      _this.query = result.query;

      _this.listen();

      // Grab initial results
      _this.refresh(true);
    });
  }

  _inherits(LiveSelect, EventEmitter);

  _prototypeProperties(LiveSelect, null, {
    listen: {
      value: function listen() {
        var _this = this;
        this.triggers.forEach(function (trigger) {
          trigger.on("change", function (payload) {
            // Update events contain both old and new values in payload
            // using 'new_' and 'old_' prefixes on the column names
            var argVals = {};

            if (payload._op === "UPDATE") {
              trigger.payloadColumns.forEach(function (col) {
                if (payload["new_" + col] !== payload["old_" + col]) {
                  argVals[col] = payload["new_" + col];
                }
              });
            } else {
              trigger.payloadColumns.forEach(function (col) {
                argVals[col] = payload[col];
              });
            }

            // Generate a map denoting which rows to replace
            var tmpRow = {};

            _.forOwn(argVals, function (value, column) {
              var alias = _this.aliases[trigger.table][column];
              tmpRow[alias] = value;
            });

            if (!_.isEmpty(tmpRow)) {
              _this.refreshQueue.push(tmpRow);

              if (MAX_CONDITIONS && _this.refreshQueue.length >= MAX_CONDITIONS) {
                _this.refresh();
              } else {
                _this.throttledRefresh();
              }
            }
          });

          trigger.on("ready", function (results) {
            // Check if all handlers are ready
            if (_this.triggers.filter(function (trigger) {
              return !trigger.ready;
            }).length === 0) {
              _this.ready = true;
              _this.emit("ready", results);
            }
          });
        });
      },
      writable: true,
      configurable: true
    },
    refresh: {
      value: function refresh(initial) {
        var _this = this;
        var params = this.params.slice(),
            where;

        if (initial) {
          where = "";
        } else if (this.refreshQueue.length) {
          // Build WHERE clause if not refreshing entire result set
          var valueCount = params.length;

          where = "WHERE " + this.refreshQueue.map(function (condition) {
            return "(" + _.map(condition, function (value, column) {
              params.push(value);
              return "" + column + " = $" + ++valueCount;
            }).join(" AND ") + ")";
          }).join(" OR ");

          this.refreshQueue = [];
        } else {
          return; // Do nothing if there are no conditions
        }

        var sql = "\n      WITH tmp AS (" + this.query + ")\n      SELECT *\n      FROM tmp\n      " + where + "\n    ";

        this.client.query(sql, params, function (error, result) {
          if (error) return _this.emit("error", error);

          _this.update(result.rows);
        });
      },
      writable: true,
      configurable: true
    },
    update: {
      value: function update(rows) {
        var _this = this;
        var diff = [];

        // Handle added/changed rows
        rows.forEach(function (row) {
          var id = row[ID_ALIAS];

          if (_this.data[id]) {
            // If this row existed in the result set,
            // check to see if anything has changed
            var hasDiff = false;

            for (var col in _this.data[id]) {
              if (_this.data[id][col] !== row[col]) {
                hasDiff = true;
                break;
              }
            }

            hasDiff && diff.push(["changed", filterAliasedProperties(_this.data[id]), filterAliasedProperties(row)]);
          } else {
            // Otherwise, it was added
            diff.push(["added", filterAliasedProperties(row)]);
          }

          _this.data[id] = row;
        });

        // Check to see if there are any
        // IDs that have been removed
        var existingIds = _.keys(this.data);

        if (existingIds.length) {
          var sql = "\n        WITH tmp AS (" + this.query + ")\n        SELECT id\n        FROM UNNEST(ARRAY['" + _.keys(this.data).join("', '") + "']) id\n        LEFT JOIN tmp ON tmp." + ID_ALIAS + " = id\n        WHERE tmp." + ID_ALIAS + " IS NULL\n      ";

          var query = {
            name: "prepared_" + murmurHash(sql),
            text: sql,
            values: this.params
          };

          // Get any IDs that have been removed
          this.client.query(query, function (error, result) {
            if (error) return _this.emit("error", error);

            result.rows.forEach(function (row) {
              var oldRow = _this.data[row.id];

              diff.push(["removed", filterAliasedProperties(oldRow)]);
              delete _this.data[row.id];
            });

            if (diff.length !== 0) {
              // Output all difference events in a single event
              _this.emit("update", diff, dataToRows(_this.data));
            }
          });
        } else if (diff.length !== 0) {
          // Output all difference events in a single event
          this.emit("update", diff, dataToRows(this.data));
        }
      },
      writable: true,
      configurable: true
    },
    flush: {
      value: function flush() {
        if (this.refreshQueue.length) {
          refresh(this.refreshQueue);
          this.refreshQueue = [];
        }
      },
      writable: true,
      configurable: true
    }
  });

  return LiveSelect;
})(EventEmitter);

function filterAliasedProperties(row) {
  return _.pick(row, function (value, key) {
    return key.substr(0, ALIAS_PREFIX.length + 1) !== ALIAS_PREFIX + "_";
  });
}

function dataToRows(data) {
  return _.map(data, function (row) {
    return filterAliasedProperties(row);
  });
}

/**
 * Adds helper columns to a query
 * @context LiveSelect instance
 * @param   String   query    The query
 * @param   Function callback A function that is called with information about the view
 */
function addHelpers(query, callback) {
  var _this = this;
  var hash = murmurHash(query);

  // If this query was cached before, reuse it
  if (cachedQueries[hash]) {
    return callback(null, cachedQueries[hash]);
  }

  var tmpName = "tmp_view_" + hash;

  var columnUsageSQL = "\n    SELECT DISTINCT\n      vc.table_name,\n      vc.column_name\n    FROM\n      information_schema.view_column_usage vc\n    WHERE\n      view_name = $1\n  ";

  var tableUsageSQL = "\n    SELECT DISTINCT\n      vt.table_name,\n      cc.column_name\n    FROM\n      information_schema.view_table_usage vt JOIN\n      information_schema.table_constraints tc ON\n        tc.table_catalog = vt.table_catalog AND\n        tc.table_schema = vt.table_schema AND\n        tc.table_name = vt.table_name AND\n        tc.constraint_type = 'PRIMARY KEY' JOIN\n      information_schema.constraint_column_usage cc ON\n        cc.table_catalog = tc.table_catalog AND\n        cc.table_schema = tc.table_schema AND\n        cc.table_name = tc.table_name AND\n        cc.constraint_name = tc.constraint_name\n    WHERE\n      view_name = $1\n  ";

  // Replace all parameter values with NULL
  var tmpQuery = query.replace(/\$\d/g, "NULL");
  var createViewSQL = "CREATE OR REPLACE TEMP VIEW " + tmpName + " AS (" + tmpQuery + ")";

  var columnUsageQuery = {
    name: "column_usage_query",
    text: columnUsageSQL,
    values: [tmpName]
  };

  var tableUsageQuery = {
    name: "table_usage_query",
    text: tableUsageSQL,
    values: [tmpName]
  };

  var sql = ["CREATE OR REPLACE TEMP VIEW " + tmpName + " AS (" + tmpQuery + ")", tableUsageQuery, columnUsageQuery];

  // Create a temporary view to figure out what columns will be used
  querySequence(this.client, sql, function (error, result) {
    if (error) return callback.call(_this, error);

    var tableUsage = result[1].rows;
    var columnUsage = result[2].rows;

    var keys = {};
    var columns = [];

    tableUsage.forEach(function (row, index) {
      keys[row.table_name] = row.column_name;
    });

    // This might not be completely reliable
    // Will match until last FROM, allowing subqueries in column selectors
    var pattern = /SELECT([\s\S]+)FROM/i;

    columnUsage.forEach(function (row, index) {
      columns.push({
        table: row.table_name,
        name: row.column_name,
        alias: "" + ALIAS_PREFIX + "_" + row.table_name + "_" + row.column_name
      });
    });

    var keySql = _.map(keys, function (value, key) {
      return "CONCAT('" + key + "', ':', \"" + key + "\".\"" + value + "\")";
    });

    var columnSql = _.map(columns, function (col, index) {
      return "\"" + col.table + "\".\"" + col.name + "\" AS " + col.alias;
    });

    query = query.replace(pattern, "\n      SELECT\n        CONCAT(" + keySql.join(", '|', ") + ") AS " + ID_ALIAS + ",\n        " + columnSql + ",\n        $1\n      FROM\n    ");

    cachedQueries[hash] = { keys: keys, columns: columns, query: query };

    return callback(null, cachedQueries[hash]);
  });
}

module.exports = LiveSelect;