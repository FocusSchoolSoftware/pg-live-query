/**
 * Execute a sequence of queries on a pg client in a transaction
 * @param  Object   client   The database client, or PgTriggers instance to
 *                            obtain a client automatically
 * @param  Boolean  debug    Print queries as they execute (optional)
 * @param  [String] queries  Queries to execute, in order
 * @param  Function callback Optional, call when complete (error, results)
 * @return Promise
 */
module.exports = function(client, debug, queries, callback){
	if(debug instanceof Array){
		callback = queries;
		queries  = debug;
		debug    = false;
	}

	return new Promise((resolve, reject) => {
		var results = [];

		if(typeof client.getClient === 'function'){
			// PgTriggers instance passed as client, obtain client
			return client.getClient((error, client, done) =>
				module.exports(client, debug, queries, callback).then(
					results => { done(); resolve(results) },
					error => { done(); reject(error) }))
		}

		if(queries.length === 0) {
			resolve();
			return callback && callback();
		}

		var sequence = queries.map((query, index, initQueries) => () => {
			debug && console.log('QUERY', index, query);

			var queryComplete = (error, rows, fields) => {
				if(error) {
					client.query('ROLLBACK', (rollbackError, result) => {
						reject(rollbackError || error);
						return callback && callback(rollbackError || error);
					});
				}

				results.push(rows);

				if(index < sequence.length - 1) {
					sequence[index + 1]();
				}
				else {
					client.query('COMMIT', (error, result) => {
						if(error) {
							reject(error);
							return callback && callback(error);
						}
						resolve(results);
						return callback && callback(null, results);
					});
				}
			}

			if(query instanceof Array) {
				client.query(query[0], query[1], queryComplete);
			}
			else {
				client.query(query, queryComplete);
			}
		});

		client.query('BEGIN', (error, result) => {
			if(error) {
				reject(error);
				return callback && callback(error);
			}
			sequence[0]()
		})
	})
}

/**
 * querySequence.noTx()
 * Perform a query sequence without a transaction
 */
module.exports.noTx = function(client, debug, queries, callback) {
  if(debug instanceof Array){
    callback = queries;
    queries = debug;
    debug = false;
  }

	return new Promise((resolve, reject) => {
		var results = [];

		if(typeof client.getClient === 'function'){
			// PgTriggers instance passed as client, obtain client
			return client.getClient((error, client, done) =>
				module.exports(client, debug, queries, callback).then(
					results => { done(); resolve(results) },
					error => { done(); reject(error) }))
		}

		if(queries.length === 0) {
			resolve();
			return callback && callback();
		}


		var sequence = queries.map(function(query, index, initQueries){
			var tmpCallback = function(error, rows, fields) {
				if(error) {
					reject(error);
					return callback(error);
				}

				results.push(rows);

				if(index < sequence.length - 1){
					sequence[index + 1]();
				}else{
					resolve(results);
					return callback(null, results);
				}
			};

			return function(){
				debug && console.log('Query Sequence', index, query);

				if(query instanceof Array) {
					client.query(query[0], query[1], tmpCallback);
				}
				else {
					client.query(query, tmpCallback);
				}
			}
		})

		sequence[0]()
	})
}

