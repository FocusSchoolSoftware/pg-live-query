var _ = require('lodash');

var randomString = require('./helpers/randomString');
var querySequence = require('../src/querySequence');

var scoresLoadFixture = require('./fixtures/scoresLoad');

exports.scoresLoad = function(test) {
  var classCount =
    process.env.CLASS_COUNT ? parseInt(process.env.CLASS_COUNT) : 10;
  var fixtureData = scoresLoadFixture.generate(
    classCount, // number of classes
    40, // assignments per class
    20, // students per class
    6   // classes per student
  );
  // Generate new names to update to
  var newStudentNames = fixtureData.students.map(student => randomString());

  printStats && console.log(
    'Students.length: ', fixtureData.students.length,
    'Assignments.length: ', fixtureData.assignments.length,
    'Scores.length: ', fixtureData.scores.length
  );

  printDebug && console.log('FIXTURE DATA\n', fixtureData);

  scoresLoadFixture.install(fixtureData, (error, result) => {
    if(error) throw error;

    var liveSelects = _.range(classCount).map(index =>
      scoresLoadFixture.createSelect(triggers, index + 1));
    var curStage = 0;

    // Stage 0 : cache initial data
    var initialData = [], readyCount = 0;
    // Stage 1 : update each student name
    var updateStudentNames = function() {
      if(liveSelects.filter(select => !select.ready).length === 0){
        querySequence(client, newStudentNames.map((name, index) =>
          [ `UPDATE students SET name = $1 WHERE id = ${index + 1}`,
            [ name ] ]), (err, res) => { });

        // Only perform this operation once
        updateStudentNames = function() {};
      }
    };
    // Stage 2 : update scores individually
    var updateScores = function() {
      var scoresToUpdate = _.range(fixtureData.scores.length);
      var queries = [];
      while(scoresToUpdate.length > 0){
        var id = scoresToUpdate.splice(
          Math.floor(Math.random() * scoresToUpdate.length), 1)[0] + 1;
        queries.push([
          `UPDATE scores SET score = $1 WHERE id = $2`,
          [ fixtureData.scores[id - 1].score * 2, id ]
        ]);
      }
      querySequence(client, queries, (err, res) => {});
    };

    liveSelects.forEach(select => {
      select.on('ready', results => {
        updateStudentNames();
      });

      select.on('update', (diff, getAll) => {
        switch(curStage){
          case 0:
            readyCount++;
            initialData[select.params[0] - 1] = _.values(getAll());

            if(readyCount === liveSelects.length){
              printDebug && console.log('INITIAL DATA\n', initialData);

              curStage++;
              readyCount = 0;

              // May happen before or after ready
              updateStudentNames();
            }
            break;
          case 1:
            readyCount++;
            test.ok(_.values(getAll())
              .map(row => row.student_name === newStudentNames[row.student_id - 1])
              .indexOf(false) === -1, 'Student name update check');

            if(readyCount === liveSelects.length){
              curStage++;
              readyCount = 0;

              updateScores();
            }
            break;
          case 2:
            if(_.values(getAll())
                .map(row =>
                  row.score === fixtureData.scores[row.score_id - 1].score * 2)
                .indexOf(false) === -1){
              // LiveSelect is only fully updated after all its scores have
              //  doubled
              readyCount++;
            }

            if(readyCount === liveSelects.length){
              test.done();
            }
            break;
        }
      });
    });
  });

}
