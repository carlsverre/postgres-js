/*jslint bitwise: true, eqeqeq: true, immed: true, newcap: true, nomen: true, onevar: true, plusplus: true, regexp: true, undef: true, white: true, indent: 2 */
/*globals include md5 node exports */
process.mixin(require('./lib/md5'));

var bits = require('./lib/bits');
var oid = require("./lib/type-oids");
var parsers = require("./lib/parsers");
var tcp = require("tcp");
var sys = require("sys");

exports.DEBUG = 0;

var postgres_parameters = {};

// http://www.postgresql.org/docs/8.3/static/protocol-message-formats.html
var formatter = {
  CopyData: function () {
    // TODO: implement
  },
  CopyDone: function () {
    // TODO: implement
  },
  Describe: function (name, type) {
    return (new bits.Encoder('D'))
      .push_raw_string(type)
      .push_cstring(name);
  },
  Execute: function (name, max_rows) {
    return (new bits.Encoder('E'))
      .push_cstring(name)
      .push_int32(max_rows);
  },
  Flush: function () {
    return new bits.Encoder('H');
  },
  FunctionCall: function () {
    // TODO: implement
  },
  Parse: function (name, query, var_types) {
    var builder = (new bits.Encoder('P'))
      .push_cstring(name)
      .push_cstring(query)
      .push_int16(var_types.length);
    var_types.each(function (var_type) {
      builder.push_int32(var_type);
    });
    return builder;
  },
  PasswordMessage: function (password) {
    return (new bits.Encoder('p'))
      .push_cstring(password);
  },
  Query: function (query) {
    return (new bits.Encoder('Q'))
      .push_cstring(query);
  },
  SSLRequest: function () {
    return (new bits.Encoder())
      .push_int32(0x4D2162F);
  },
  StartupMessage: function (options) {
    // Protocol version number 3
    return (new bits.Encoder())
      .push_int32(0x30000)
      .push_hash(options);
  },
  Sync: function () {
    return new bits.Encoder('S');
  },
  Terminate: function () {
    return new bits.Encoder('X');
  }
};

// Parse response streams from the server
function parse_response(code, stream) {
  var input, type, args, num_fields, data, size, i;
  input = new bits.Decoder(stream);
  args = [];
  switch (code) {
  case 'R':
    switch (stream.shift_int32()) {
    case 0:
      type = "AuthenticationOk";
      break;
    case 2:
      type = "AuthenticationKerberosV5";
      break;
    case 3:
      type = "AuthenticationCleartextPassword";
      break;
    case 4:
      type = "AuthenticationCryptPassword";
      args = [stream.shift_raw_string(2)];
      break;
    case 5:
      type = "AuthenticationMD5Password";
      args = [stream.shift_raw_string(4)];
      break;
    case 6:
      type = "AuthenticationSCMCredential";
      break;
    case 7:
      type = "AuthenticationGSS";
      break;
    case 8:
      // TODO: add in AuthenticationGSSContinue
      type = "AuthenticationSSPI";
      break;
    }
    break;
  case 'E':
    type = "ErrorResponse";
    args = [{}];
    stream.shift_multi_cstring().forEach(function (field) {
      args[0][field[0]] = field.substr(1);
    });
    break;
  case 'S':
    type = "ParameterStatus";
    args = [stream.shift_cstring(), stream.shift_cstring()];
    break;
  case 'K':
    type = "BackendKeyData";
    args = [stream.shift_int32(), stream.shift_int32()];
    break;
  case 'Z':
    type = "ReadyForQuery";
    args = [stream.shift_raw_string(1)];
    break;
  case 'T':
    type = "RowDescription";
    num_fields = stream.shift_int16();
    data = [];
    for (i = 0; i < num_fields; i += 1) {
      data.push({
        field: stream.shift_cstring(),
        table_id: stream.shift_int32(),
        column_id: stream.shift_int16(),
        type_id: stream.shift_int32(),
        type_size: stream.shift_int16(),
        type_modifier: stream.shift_int32(),
        format_code: stream.shift_int16()
      });
    }
    args = [data];
    break;
  case 'D':
    type = "DataRow";
    data = [];
    num_fields = stream.shift_int16();
    for (i = 0; i < num_fields; i += 1) {
      size = stream.shift_int32();
      if (size === -1) {
        data.push(null);
      } else {
        data.push(stream.shift_raw_string(size));
      }
    }
    args = [data];
    break;
  case 'C':
    type = "CommandComplete";
    args = [stream.shift_cstring()];
    break;
  }
  if (!type) {
    sys.debug("Unknown response " + code);  
  }
  return {type: type, args: args};
}


exports.Connection = function (database, username, password, port, host) {
  var connection, events, query_queue, row_description, results, readyState, closeState;
  var query_callback, query_promise;

  // Default to port 5432
  if (port === undefined) {
    port = 5432;
  }
  
  t_host = host;
  if (t_host === undefined) {
      t_host = "localhost";
  }

  connection = tcp.createConnection(port, host=t_host);
  events = new process.EventEmitter();
  query_queue = [];
  readyState = false;
  closeState = false;

  // Sends a message to the postgres server
  function sendMessage(type, args) {
    var stream = (formatter[type].apply(this, args)).toString();
    if (exports.DEBUG > 0) {
      sys.debug("Sending " + type + ": " + JSON.stringify(args));
      if (exports.DEBUG > 2) {
        sys.debug("->" + JSON.stringify(stream));
      }
    }
    connection.send(stream, "binary");
  }
  
  // Set up tcp client
  connection.setEncoding("binary");
  connection.addListener("connect", function () {
    sendMessage('StartupMessage', [{user: username, database: database}]);
  });
  connection.addListener("receive", function (data) {
    var input, code, len, stream, command;
    input = new bits.Decoder(data);
    if (exports.DEBUG > 2) {
      sys.debug("<-" + JSON.stringify(data));
    }
  
    while (input.data.length > 0) {
      code = input.shift_code();
      len = input.shift_int32();
      stream = new bits.Decoder(input.shift_raw_string(len - 4));
      if (exports.DEBUG > 1) {
        sys.debug("stream: " + code + " " + JSON.stringify(stream));
      }
      command = parse_response(code, stream);
      if (command.type) {
        if (exports.DEBUG > 0) {
          sys.debug("Received " + command.type + ": " + JSON.stringify(command.args));
        }
        command.args.unshift(command.type);
        events.emit.apply(events, command.args);
      }
    }
  });
  connection.addListener("eof", function (data) {
    connection.close();
  });
  connection.addListener("disconnect", function (had_error) {
    if (had_error) {
      sys.debug("CONNECTION DIED WITH ERROR");
    }
  });

  // Set up callbacks to automatically do the login
  events.addListener('AuthenticationMD5Password', function (salt) {
    var result = "md5" + md5(md5(password + username) + salt);
    sendMessage('PasswordMessage', [result]);
  });
  events.addListener('AuthenticationCleartextPassword', function () {
    sendMessage('PasswordMessage', [password]);
  });
  events.addListener('ErrorResponse', function (e) {
    if (e.S === 'FATAL') {
      sys.debug(e.S + ": " + e.M);
      connection.close();
      if(query_promise) query_promise.emitError(e.M);
    }
  });
  events.addListener('ParameterStatus', function(key, value) {
    postgres_parameters[key] = value;
  });
  events.addListener('ReadyForQuery', function () {
    if (query_queue.length > 0) {
      var query = query_queue.shift();
      query_callback = query.callback || null;
      query_promise = query.promise || null;
      sendMessage('Query', [query.sql]);
      readyState = false;
    } else {
      if (closeState) {
        connection.close();
      } else {
        readyState = true;
      }
    }
  });
  events.addListener("RowDescription", function (data) {
    row_description = data;
    results = [];
  });
  events.addListener("DataRow", function (data) {
    var row, i, l, description, value;
    row = {};
    l = data.length;
    for (i = 0; i < l; i += 1) {
      description = row_description[i];
      value = data[i];
      if (value !== null) {
        // TODO: investigate to see if these numbers are stable across databases or
        // if we need to dynamically pull them from the pg_types table
        switch (description.type_id) {
        case oid.BOOL:
          value = value === 't';
          break;
        case oid.INT8:
        case oid.INT2:
        case oid.INT4:
          value = parseInt(value, 10);
          break;
        case oid.DATE:
        case oid.TIME:
        case oid.TIMESTAMP:
        case oid.TIMESTAMPTZ:
          value = parsers.parseDateFromPostgres(
                            value,
                            postgres_parameters['DateStyle'],
                            description.type_id
                          );
          break;
        }
      }
      row[description.field] = value;
    }
    results.push(row);
  });
  events.addListener('CommandComplete', function (data) {
    if(query_callback) query_callback(results);
    else if(query_promise) query_promise.emitSuccess(results);
  });

  this.query = function (sql, args) {
    var promise = new process.Promise();

    if (args == null) {
      
      // This has no parameters to manipulate.
      
      query_queue.push({sql: sql, promise: promise});
      if (readyState) {
        events.emit('ReadyForQuery');
      }
    }
    else {
      // We have an args list.
      // This means, we have to map our ?'s and test for a variety of 
      // edge cases.
      sys.puts("Got args.");
      var i = 0;
      var slice = md5(md5(sql));
      //sys.p(slice);
      var offset = Math.floor(Math.random() * 10);
      cont = "$" + slice.replace(/\d/g, "").slice(offset,4+offset) + "$";
      var treated = sql;
      sys.p(cont);
      if (sql.match(/\?/)) {
        treated = sql.replace(/\?/g, function (str, offset, s) {
          if (!args[i]) {
            // raise an error
            throw new Error("Argument "+i+" does not exist!");
          }
          return cont+args[i]+cont;
        } );
      }
      sys.p(treated);
      query_queue.push({sql: treated, promise: promise});
      if (readyState) {
        events.emit('ReadyForQuery');
      }
    }

    return promise;
  };
  
  this.prepare = function (query) {
    
    var r = new process.Promise();
    var name = md5(md5(query));
    var offset = Math.floor(Math.random() * 10);
    name = name.replace(/\d/g, "").slice(offset,4+offset);
    
    var treated = query;
    var i = 0;
    if (query.match(/\?/)) {
      
      treated = treated.replace(/\?/g, function (str, p1, offset, s) {
        i = i + 1;
        return "$"+i;
      });
    }
    
    stmt = "PREPARE " + name + " AS " + treated;
    
    var conn = this;
    
    query_queue.push({sql: stmt, callback: function (c) {
        var q = new Stmt(name, i, conn );
        r.emitSuccess(q);
      }
    });
    return r;
  };
  
  this.close = function () {
  closeState = true;
  };
  
};

function Stmt (name, len, conn) {
  var stmt = "EXECUTE "+name+" ( ";
  var que = [];
  for (var i = 1; i<=len; i++) {
    que.push("?");
  }
  stmt = stmt + que.join(",") + " )";
  
  sys.puts(stmt);
  
  this.execute = function (args) {
    if (args.length > len) {
      throw new Error("Cannot execute: Too many arguments");
    }
    else if (args.length < len) {
      // Pad out the length with nulls.
      for (var i = args.length; i<= len; i++) {
        args.push(null);
      }
    }
    else {
      // Nothing to see here.
      ;
    }

    return conn.query(stmt, args);
  };
}
