"use strict";

var _prototypeProperties = function (child, staticProps, instanceProps) { if (staticProps) Object.defineProperties(child, staticProps); if (instanceProps) Object.defineProperties(child.prototype, instanceProps); };

var _inherits = function (subClass, superClass) { if (typeof superClass !== "function" && superClass !== null) { throw new TypeError("Super expression must either be null or a function, not " + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) subClass.__proto__ = superClass; };

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } };

var _ = require("lodash");
var deep = require("deep-diff");
var EventEmitter = require("events").EventEmitter;

var murmurHash = require("murmurhash-js").murmur3;
var querySequence = require("./querySequence");

var cachedQueryTables = {};

// Minimum duration in milliseconds between refreshing results
// TODO: determine based on load
// https://git.focus-sis.com/beng/pg-notify-trigger/issues/6
var THROTTLE_INTERVAL = 1000;

var c = 0;

var LiveSelect = (function (EventEmitter) {
	function LiveSelect(parent, query, params) {
		var _this = this;
		_classCallCheck(this, LiveSelect);

		var connect = parent.connect;
		var channel = parent.channel;
		var rowCache = parent.rowCache;


		this.query = query;
		this.params = params || [];
		this.connect = connect;
		this.rowCache = rowCache;
		this.data = [];
		this.hashes = [];
		this.ready = false;
		this.queryHash = murmurHash(query);

		// throttledRefresh method buffers
		this.throttledRefresh = _.debounce(this.refresh, THROTTLE_INTERVAL);

		this.connect(function (error, client, done) {
			if (error) return _this.emit("error", error);

			init.call(_this, client, function (error, tables) {
				if (error) return _this.emit("error", error);

				done();

				_this.triggers = tables.map(function (table) {
					return parent.createTrigger(table);
				});

				_this.triggers.forEach(function (trigger) {
					trigger.on("ready", function () {
						// Check if all handlers are ready
						var pending = _this.triggers.filter(function (trigger) {
							return !trigger.ready;
						});

						if (pending.length === 0) {
							_this.ready = true;
							_this.emit("ready");
						}

						trigger.on("change", _this.throttledRefresh.bind(_this));
					});
				});
			});
		});

		// Grab initial results
		this.refresh();
	}

	_inherits(LiveSelect, EventEmitter);

	_prototypeProperties(LiveSelect, null, {
		refresh: {
			value: function refresh() {
				var _this = this;
				// Run a query to get an updated hash map
				var sql = "\n\t\t\tWITH\n\t\t\t\ttmp AS (" + this.query + ")\n\t\t\tSELECT\n\t\t\t\ttmp2._hash\n\t\t\tFROM\n\t\t\t\t(\n\t\t\t\t\tSELECT\n\t\t\t\t\t\tMD5(CAST(tmp.* AS TEXT)) AS _hash\n\t\t\t\t\tFROM\n\t\t\t\t\t\ttmp\n\t\t\t\t) tmp2\n\t\t";

				this.connect(function (error, client, done) {
					if (error) return _this.emit("error", error);

					client.query(sql, _this.params, function (error, result) {
						if (error) return _this.emit("error", error);

						var freshHashes = _.pluck(result.rows, "_hash");
						var diff = deep.diff(_this.hashes, freshHashes);
						var fetch = {};

						// Store the new hash map
						_this.hashes = freshHashes;

						// If nothing has changed, stop here
						if (!diff || !diff.length) {
							return;
						}

						// Build a list of changes and hashes to fetch
						var changes = diff.map(function (change) {
							var tmpChange = {};

							if (change.kind === "E") {
								_.extend(tmpChange, {
									type: "changed",
									index: change.path.pop(),
									oldKey: change.lhs,
									newKey: change.rhs
								});

								if (_this.rowCache.get(tmpChange.oldKey) === null) {
									fetch[tmpChange.oldKey] = true;
								}

								if (_this.rowCache.get(tmpChange.newKey) === null) {
									fetch[tmpChange.newKey] = true;
								}
							} else if (change.kind === "A") {
								_.extend(tmpChange, {
									index: change.index
								});

								if (change.item.kind === "N") {
									tmpChange.type = "added";
									tmpChange.key = change.item.rhs;
								} else {
									tmpChange.type = "removed";
									tmpChange.key = change.item.lhs;
								}

								if (_this.rowCache.get(tmpChange.key) === null) {
									fetch[tmpChange.key] = true;
								}
							} else {
								throw new Error("Unrecognized change: " + JSON.stringify(change));
							}

							return tmpChange;
						});

						if (_.isEmpty(fetch)) {
							done();
							_this.update(changes);
						} else {
							var sql = "\n\t\t\t\t\t\tWITH\n\t\t\t\t\t\t\ttmp AS (" + _this.query + ")\n\t\t\t\t\t\tSELECT\n\t\t\t\t\t\t\ttmp2.*\n\t\t\t\t\t\tFROM\n\t\t\t\t\t\t\t(\n\t\t\t\t\t\t\t\tSELECT\n\t\t\t\t\t\t\t\t\tMD5(CAST(tmp.* AS TEXT)) AS _hash,\n\t\t\t\t\t\t\t\t\ttmp.*\n\t\t\t\t\t\t\t\tFROM\n\t\t\t\t\t\t\t\t\ttmp\n\t\t\t\t\t\t\t) tmp2\n\t\t\t\t\t\tWHERE\n\t\t\t\t\t\t\ttmp2._hash IN ('" + _.keys(fetch).join("', '") + "')\n\t\t\t\t\t";

							// Fetch hashes that aren't in the cache
							client.query(sql, _this.params, function (error, result) {
								if (error) return _this.emit("error", error);

								result.rows.forEach(function (row) {
									return _this.rowCache.add(row._hash, row);
								});
								done();
								_this.update(changes);
							});
						}
					});
				});
			},
			writable: true,
			configurable: true
		},
		update: {
			value: function update(changes) {
				var _this = this;
				console.log("Update Count: ", ++c);

				var remove = [];

				// Emit an update event with the changes
				var changes = changes.map(function (change) {
					var args = [change.type];

					if (change.type === "added") {
						var row = _this.rowCache.get(change.key);
						args.push(change.index, row);
					} else if (change.type === "changed") {
						var oldRow = _this.rowCache.get(change.oldKey);
						var newRow = _this.rowCache.get(change.newKey);
						args.push(change.index, oldRow, newRow);
						remove.push(change.oldKey);
					} else if (change.type === "removed") {
						var row = _this.rowCache.get(change.key);
						args.push(change.index, row);
						remove.push(change.key);
					}

					if (args[2] === null) {
						return _this.emit("error", new Error("CACHE_MISS: " + (args.length === 3 ? change.key : change.oldKey)));
					}
					if (args.length > 3 && args[3] === null) {
						return _this.emit("error", new Error("CACHE_MISS: " + change.newKey));
					}

					return args;
				});

				remove.forEach(function (key) {
					return _this.rowCache.remove(key);
				});

				this.emit("update", filterHashProperties(changes));
			},
			writable: true,
			configurable: true
		},
		stop: {
			value: function stop() {
				var _this = this;
				this.hashes.forEach(function (key) {
					return _this.rowCache.remove(key);
				});
				this.triggers.forEach(function (trigger) {
					return trigger.removeAllListeners();
				});
				this.removeAllListeners();
			},
			writable: true,
			configurable: true
		}
	});

	return LiveSelect;
})(EventEmitter);

function init(client, callback) {
	var _ref = this;
	var query = _ref.query;
	var queryHash = _ref.queryHash;


	// If this query was cached before, reuse it
	if (!cachedQueryTables[queryHash]) {
		cachedQueryTables[queryHash] = new Promise(function (resolve, reject) {
			// Replace all parameter values with NULL
			var tmpQuery = query.replace(/\$\d/g, "NULL");
			var tmpName = "tmp_view_" + queryHash;

			var sql = ["CREATE OR REPLACE TEMP VIEW " + tmpName + " AS (" + tmpQuery + ")", ["SELECT DISTINCT vc.table_name\n\t\t\t\t\tFROM information_schema.view_column_usage vc\n\t\t\t\t\tWHERE view_name = $1", [tmpName]], ["INSERT INTO _liveselect_queries (id, query)\n\t\t\t\t\tVALUES ($1, $2)", [queryHash, query]], ["INSERT INTO _liveselect_column_usage\n\t\t\t\t\t\t(query_id, table_schema, table_name, column_name)\n\t\t\t\t\tSELECT $1, vc.table_schema, vc.table_name, vc.column_name\n\t\t\t\t\tFROM information_schema.view_column_usage vc\n\t\t\t\t\tWHERE vc.view_name = $2", [queryHash, tmpName]]];

			querySequence(client, sql, function (error, result) {
				console.log(error);
				if (error) return reject(error);

				var tables = result[1].rows.map(function (row) {
					return row.table_name;
				});

				resolve(tables);
			});
		});
	}

	cachedQueryTables[queryHash].then(function (result) {
		callback(null, result);
	}, function (error) {
		callback(error, null);
	});
}

module.exports = LiveSelect;

function filterHashProperties(diff) {
	return diff.map(function (event) {
		delete event[2]._hash;
		if (event.length > 3) delete event[3]._hash;
		return event;
	});
}