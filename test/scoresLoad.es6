var _ = require('lodash');

var randomString = require('./helpers/randomString');
var querySequence = require('../src/querySequence');

var scoresLoadFixture = require('./fixtures/scoresLoad');

exports.scoresLoad = function(test) {
	var classCount =
		process.env.CLASS_COUNT ? parseInt(process.env.CLASS_COUNT) : 1;
	var selectsPerClass =
		process.env.CLIENT_MULTIPLIER ? parseInt(process.env.CLIENT_MULTIPLIER) : 1;

	// Collect and report memory usage information
	if(printStats){
		var memoryUsageSnapshots = [];
		var updateMemoryUsage = function() {
			memoryUsageSnapshots.push({
				time: Date.now(),
				memory: process.memoryUsage().heapTotal
			});
		};
		var memoryInterval = setInterval(updateMemoryUsage, 500);
	}


	var fixtureData = scoresLoadFixture.generate(
		classCount, // number of classes
		4,          // assignments per class
		20,         // students per class
		6           // classes per student
	);
	// Generate new names to update to
	var newStudentNames = fixtureData.students.map(student => randomString());

	printStats && console.log(
		'Students.length: ', fixtureData.students.length,
		'Assignments.length: ', fixtureData.assignments.length,
		'Scores.length: ', fixtureData.scores.length
	);

	printDebug && console.log('FIXTURE DATA\n', fixtureData);

	scoresLoadFixture.install(triggers, fixtureData).then(result => {
		var liveSelects = [];
		_.range(selectsPerClass).forEach(selectIndex => {
			liveSelects = liveSelects.concat(_.range(classCount).map(index =>
				triggers.select(`
					SELECT
						students.name  AS student_name,
						students.id    AS student_id,
						assignments.id AS assignment_id,
						scores.id      AS score_id,
						assignments.name,
						assignments.value,
						scores.score
					FROM
						scores
					INNER JOIN assignments ON
						(assignments.id = scores.assignment_id)
					INNER JOIN students ON
						(students.id = scores.student_id)
					WHERE
						assignments.class_id = $1
				`, [ index + 1 ])));
		});
		var curStage = 0;

		// Stage 0 : cache initial data
		var initialData = []
		var readyCount  = 0;

		// Stage 1 : update each student name
		var updateStudentNames = function() {
			if(liveSelects.filter(select => !select.ready).length === 0){
				querySequence.noTx(triggers, newStudentNames.map((name, index) =>
					[ `UPDATE students SET name = $1 WHERE id = ${index + 1}`,
						[ name ] ]));

				// Only perform this operation once
				updateStudentNames = function() {};
			}
		};

		// Stage 2 : update scores individually
		var updateScores = function() {
			var scoresToUpdate = _.range(fixtureData.scores.length);
			var queries        = [];

			while(scoresToUpdate.length > 0){
				var id = scoresToUpdate.splice(
					Math.floor(Math.random() * scoresToUpdate.length), 1)[0] + 1;

				queries.push([
					`UPDATE scores SET score = $1 WHERE id = $2`,
					[ fixtureData.scores[id - 1].score * 2, id ]
				]);
			}
			querySequence.noTx(triggers, queries);
		};

		liveSelects.forEach(select => {
			select.on('ready', results => {
				updateStudentNames();
			});

			select.on('update', (diff) => {
				switch(curStage){
					case 0:
						readyCount++;
						initialData[select.params[0] - 1] = _.values(diff);

						if(readyCount === liveSelects.length){
							printDebug && console.log('INITIAL UPDATE\n', initialData);

							curStage++;
							readyCount = 0;

							// May happen before or after ready
							updateStudentNames();
						}
						break;
					case 1:
						readyCount++;
						test.ok(diff
							.map(change =>
								change[3].student_name ===
									newStudentNames[change[3].student_id - 1])
							.indexOf(false) === -1, 'Student name update check');

						if(readyCount === liveSelects.length){
							curStage++;
							readyCount = 0;

							updateScores();
						}
						break;
					case 2:
						if(diff
								.map(change =>
									change[3].score ===
										fixtureData.scores[change[3].score_id - 1].score * 2)
								.indexOf(false) === -1){
							// LiveSelect is only fully updated after all its scores have
							//  doubled
							readyCount++;
							select.stop();
						}

						if(readyCount === liveSelects.length){
							if(printStats){
								clearInterval(memoryInterval);
								console.log(JSON.stringify(memoryUsageSnapshots));
							}
							test.done();
						}
						break;
				}
			});
		});
	}, error => console.error(error));

}
