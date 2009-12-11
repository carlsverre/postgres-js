var sys = require("sys");
var Postgres = require("./postgres");

Postgres.DEBUG= 1;

var db = new Postgres.Connection("database", "username", "password");
db.query("SELECT * FROM test");
db.query("SELECT * FROM test").addCallback(function (data) {
  sys.p(data);
});
db.close();
