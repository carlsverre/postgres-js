var oids = require('./type-oids'),
    sys  = require('sys');

// DATE parsing

// parse a string like YYYY-MM-DD into 
var date_regex = {
  "ISO": /(\d{4})-(\d{2})-(\d{2}).*/,
  "ISOr": "$2/$3/$1"
}
var time_regex = {
  "ISO": /.*(\d{2}):(\d{2}):(\d{2}).*/,
  "ISOr": "$1:$2:$3"
}
var tz_regex = {
  "ISO": /.*:\d{2}-(\d{2})$/,
  "ISOr": "GMT-$100"
}

exports.parseDateFromPostgres = function (str,datestyle,OID) {
  var style = datestyle.split(',');
  var order = style[1]; style = style[0].replace(/^\s+|\s+$/,'');

  if (!(style in date_regex)) {
    sys.debug("Error datestyle not implemented: " + style);
  }

  var date='',time='',tz='';
  switch(OID) {
    case oids.TIMESTAMPTZ:
      tz = str.replace(tz_regex[style],tz_regex[style+'r']);
      if (tz == str) tz = '';
    case oids.TIMESTAMP:
    case oids.DATE:
      date = str.replace(date_regex[style],date_regex[style+'r']);
      if (date == str) date = '';
      if (OID==oids.DATE) break;
    case oids.TIME:
      time = ' ' + str.replace(time_regex[style],time_regex[style+'r']);
      if (time == str) time = '';
  }

  date = ((date=='')?'January 1, 1970':date) + ((time=='')?'':' ') + time + ((tz=='')?'':' ') + tz;

  var d = new Date();
  d.setTime(Date.parse(date));

  return d;
};

// turn a number 5 into a string 05
function pad (p,num) {
  num = ''+num;
  return ((num.length==1)?p:'') + num;
}

exports.formatDateForPostgres = function(d, OID) {
  var date='',time='',tz='';
  switch(OID) {
    case oids.TIMESTAMPTZ:
      tz = '-' + d.getTimezoneOffset()/60;
    case oids.TIMESTAMP:
    case oids.DATE:
      date = [d.getFullYear(),pad('0',d.getMonth()+1),pad('0',d.getDate())].join('');
      if (OID==oids.DATE) break;
    case oids.TIME:
      time = [pad('0',d.getHours()),pad('0',d.getMinutes()),pad('0',d.getSeconds())].join(':');
  }

  return date + ((time=='')?'':' ') + time + ((tz=='')?'':' ') + tz;
}
