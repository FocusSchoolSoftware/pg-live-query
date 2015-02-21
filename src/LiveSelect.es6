var _            = require('lodash');
var deep         = require('deep-diff');
var EventEmitter = require('events').EventEmitter;

var murmurHash    = require('murmurhash-js').murmur3;
var querySequence = require('./querySequence');

var cachedQueryTables = {};

// Minimum duration in milliseconds between refreshing results
// TODO: determine based on load
// https://git.focus-sis.com/beng/pg-notify-trigger/issues/6
const THROTTLE_INTERVAL = 1000;

var c = 0;

class LiveSelect extends EventEmitter {
	constructor(parent, query, params) {
		var { connect, channel, rowCache } = parent;

		this.query     = query;
		this.params    = params || [];
		this.connect   = connect;
		this.rowCache  = rowCache;
		this.data      = [];
		this.hashes    = [];
		this.ready     = false;
		this.queryHash = murmurHash(query);

		// throttledRefresh method buffers
		this.throttledRefresh = _.debounce(this.refresh, THROTTLE_INTERVAL);

		this.connect((error, client, done) => {
			if(error) return this.emit('error', error);

			init.call(this, client, (error, tables) => {
				if(error) return this.emit('error', error);

				done();

				this.triggers = tables.map(table => parent.createTrigger(table));

				this.triggers.forEach(trigger => {
					trigger.on('ready', () => {
						// Check if all handlers are ready
						var pending = this.triggers.filter(trigger => !trigger.ready);

						if(pending.length === 0) {
							this.ready = true;
							this.emit('ready');
						}

						trigger.on('change', this.throttledRefresh.bind(this));
					});
				});
			});
		});

		// Grab initial results
		this.refresh();
	}

	refresh() {
		// Run a query to get an updated hash map
		var sql = `
			WITH
				tmp AS (${this.query})
			SELECT
				tmp2._hash
			FROM
				(
					SELECT
						MD5(CAST(tmp.* AS TEXT)) AS _hash
					FROM
						tmp
				) tmp2
		`;

		this.connect((error, client, done) => {
			if(error) return this.emit('error', error);

			client.query(sql, this.params, (error, result) =>  {
				if(error) return this.emit('error', error);

				var freshHashes = _.pluck(result.rows, '_hash');
				var diff   = deep.diff(this.hashes, freshHashes);
				var fetch  = {};

				// Store the new hash map
				this.hashes = freshHashes;

				// If nothing has changed, stop here
				if(!diff || !diff.length) {
					return;
				}

				// Build a list of changes and hashes to fetch
				var changes = diff.map(change => {
					var tmpChange = {};

					if(change.kind === 'E') {
						_.extend(tmpChange, {
							type   : 'changed',
							index  : change.path.pop(),
							oldKey : change.lhs,
							newKey : change.rhs
						});

						if(this.rowCache.get(tmpChange.oldKey) === null) {
							fetch[tmpChange.oldKey] = true;
						}

						if(this.rowCache.get(tmpChange.newKey) === null) {
							fetch[tmpChange.newKey] = true;
						}
					}
					else if(change.kind === 'A') {
						_.extend(tmpChange, {
							index : change.index
						})

						if(change.item.kind === 'N') {
							tmpChange.type = 'added';
							tmpChange.key  = change.item.rhs;
						}
						else {
							tmpChange.type = 'removed';
							tmpChange.key  = change.item.lhs;
						}

						if(this.rowCache.get(tmpChange.key) === null) {
							fetch[tmpChange.key] = true;
						}
					}
					else {
						throw new Error(`Unrecognized change: ${JSON.stringify(change)}`);
					}

					return tmpChange;
				});

				if(_.isEmpty(fetch)) {
					done();
					this.update(changes);
				}
				else {
					var sql = `
						WITH
							tmp AS (${this.query})
						SELECT
							tmp2.*
						FROM
							(
								SELECT
									MD5(CAST(tmp.* AS TEXT)) AS _hash,
									tmp.*
								FROM
									tmp
							) tmp2
						WHERE
							tmp2._hash IN ('${_.keys(fetch).join("', '")}')
					`;

					// Fetch hashes that aren't in the cache
					client.query(sql, this.params, (error, result) => {
						if(error) return this.emit('error', error);

						result.rows.forEach(row => this.rowCache.add(row._hash, row));
						done();
						this.update(changes);
					});
				}
			});
		});
	}

	update(changes) {
		console.log('Update Count: ', ++c);

		var remove = [];

		// Emit an update event with the changes
		var changes = changes.map(change => {
			var args = [change.type];

			if(change.type === 'added') {
				var row = this.rowCache.get(change.key);
				args.push(change.index, row);
			}
			else if(change.type === 'changed') {
				var oldRow = this.rowCache.get(change.oldKey);
				var newRow = this.rowCache.get(change.newKey);
				args.push(change.index, oldRow, newRow);
				remove.push(change.oldKey);
			}
			else if(change.type === 'removed') {
				var row = this.rowCache.get(change.key);
				args.push(change.index, row);
				remove.push(change.key);
			}

			if(args[2] === null){
				return this.emit('error', new Error(
					'CACHE_MISS: ' + (args.length === 3 ? change.key : change.oldKey)));
			}
			if(args.length > 3 && args[3] === null){
				return this.emit('error', new Error('CACHE_MISS: ' + change.newKey));
			}

			return args;
		});

		remove.forEach(key => this.rowCache.remove(key));

		this.emit('update', filterHashProperties(changes));
	}

	stop() {
		this.hashes.forEach(key => this.rowCache.remove(key));
		this.triggers.forEach(trigger => trigger.removeAllListeners());
		this.removeAllListeners();
	}
}

function init(client, callback){
	var { query, queryHash } = this;

	// If this query was cached before, reuse it
	if(!cachedQueryTables[queryHash]) {
		cachedQueryTables[queryHash] = new Promise((resolve, reject) => {
			// Replace all parameter values with NULL
			var tmpQuery = query.replace(/\$\d/g, 'NULL');
			var tmpName  = `tmp_view_${queryHash}`;

			var sql = [
				`CREATE OR REPLACE TEMP VIEW ${tmpName} AS (${tmpQuery})`,
				[`SELECT DISTINCT vc.table_name
					FROM information_schema.view_column_usage vc
					WHERE view_name = $1`, [ tmpName ] ],
				[`INSERT INTO _liveselect_queries (id, query)
					VALUES ($1, $2)`, [queryHash, query] ],
				[`INSERT INTO _liveselect_column_usage
						(query_id, table_schema, table_name, column_name)
					SELECT $1, vc.table_schema, vc.table_name, vc.column_name
					FROM information_schema.view_column_usage vc
					WHERE vc.view_name = $2`, [ queryHash, tmpName ] ]
			];

			querySequence(client, sql, (error, result) => {
				console.log(error);
				if(error) return reject(error);

				var tables = result[1].rows.map(row => row.table_name);

				resolve(tables);
			});
		});
	}

	cachedQueryTables[queryHash].then((result) => {
		callback(null, result);
	}, (error) => {
		callback(error, null);
	});
}

module.exports = LiveSelect;

function filterHashProperties(diff) {
	return diff.map(event => {
		delete event[2]._hash;
		if(event.length > 3) delete event[3]._hash;
		return event;
	});
}
