/***
  Routes controller, of sorts
  All routes logic and management goes here
***/

var _   = require('underscore'),
    fs  = require('fs'),
    async = require('async'),
    caching = require("./caching.js"),
    validate = require('./validate.js');

// return parsed routes
var getRoutes = function(r) {

  // verify routes are supplied correctly
  if (_.isUndefined(r) || !_.isString(r) || !fs.existsSync(r)) {
    console.log('Routes file not supplied or not present.');
    process.exit(0);
  }

  r = fs.readFileSync(r, {encoding: 'utf-8'});

  try {
    r = JSON.parse(r);
  } catch(e) {
    console.log('Cannot parse routes file as JSON');
    console.log(e);
    process.exit(0);
  }

  return r.routes;
}

// return authentication object
var getAuthentication = function(r, authentication) {

  // verify routes are supplied correctly
  if (_.isUndefined(r) || !_.isString(r) || !fs.existsSync(r)) {
    console.log('Routes file not supplied or not present.');
    process.exit(0);
  }

  r = fs.readFileSync(r, {encoding: 'utf-8'});

  try {
    r = JSON.parse(r);
  } catch(e) {
    console.log('Cannot parse routes file as JSON');
    console.log(e);
    process.exit(0);
  }

  return (!_.isUndefined(r.authentication[authentication])?r.authentication[authentication]:false);

}

// when request is received, check whether the calls parameters are present
// and match those defined in the routes
var parseRequest = function(apicall, req, res) {

  var opts;

  // post & puts parameters are in req.body, but get parameters are in req.query
  switch(req.route.method) {
    case 'post':
    case 'put':
    case 'delete':
      opts = _.clone(req.body);
      break;
    default:
      opts = _.clone(req.query);
  }

  // get params from route
  for (var rp in req.params) {
    opts[rp] = req.params[rp];
  }
  
  // get cookies
  opts.cookies = {  cookie: req.cookie,
                    signedCookies: req.signedCookie };

  // the error messages array
  var errors = validate.parameters(apicall, opts, req.files);

  // if there are some errors
  if(errors.messages.length) {

    // return 200 and the errors
    return res.send(200, { "success": false, "error": errors } );

  }

  delegate(apicall, opts, req, res);

}

var delegate = function (apicall, opts, req, res) {

  // if there is a call back for this API call
  if(apicall.callback && apicall.library) {

    var series = {};

    // do the authentication request, if required
    if (apicall.authentication) {
      series.auth = function(callback) {

        var auth_lib = require(apicall.authentication.library);

        auth_lib[apicall.authentication.callback](opts, function(err, data) {
          return callback(err, data);
        });

      }
    }

    // process the API call
    series.request = function(callback) {

      var lib = apicall.library.split("/");
      var cachekey = [lib[lib.length-1], apicall.callback];

      var keys = Object.keys(opts);
      keys.sort();

      for (var k in keys) {

        if (keys[k] == '_use_cache') {
          continue;
        }

        cachekey.push(keys[k]);
        cachekey.push((opts[keys[k]]?opts[keys[k]]:""));
      }

      cachekey = cachekey.join("");

      caching.get((opts._use_cache?apicall.caching:false), cachekey, function(err, cached) {

        // didn't get anything from cache
        if (err || _.isNull(cached)) {

          // load the library
          var lib = require(apicall.library);

          // call the callback
          lib[apicall.callback](opts, function(err, data) {

            // store retrieved value in cache if no error
            if (apicall.cache !== false && !err) {
              caching.set(apicall.caching, cachekey, data);
            }

            return callback(err, data);

          });

        }

        // did get from cache
        else {
          console.log('got from cache', cachekey)
          return callback(null, cached);
        }


      });

    }

    async.series(series, function(err, result) {

      // respond with returned data or an error message
      if (err) {

        // send the response back to the client
        var sendResponse = {
          "success": false,
          "error": err
        }

        // if result.request is set that means the series.request function ran
        // get and send its data
        if (result.request) {
          sendResponse.data = result.request;
        }

        return res.send(200, sendResponse);

      } else {
        var sendResponse;
        
        if(result.request.responseType) {
          switch(result.request.responseType) {
            case 'file':
              res.sendFile(result.request.filename);
              break;
            case 'download':
              res.download(result.request.filename);
              break;
          };
          
          return;
        }

        // send the response back to the client
        if(apicall.rawResponse) {
            sendResponse = result.request;
        } else {
            // process any cookies to be set by the auth function
            if(result.auth.setCookies) {
                for(var c in result.auth.setCookies) {
                  var cook = result.auth.setCookies[c];
                  res.cookie(cook.name, cook.value, cook.options);
                }
            }
            
            // process any cookies to be set by the request function
            // this can potentially overwrite any set by the auth function
            if(result.request.setCookies) {
                for(var c in result.request.setCookies) {
                  var cook = result.request.setCookies[c];
                  res.cookie(cook.name, cook.value, cook.options);
                }
                
                // keeps the cookie stuff out of the response (shouldn't be here in the first place)
                delete result.request.setCookies;
            }
            
            sendResponse = {
              "success": true,
              "data": result.request
            }
        }

        return res.send(200, sendResponse);
      }
    });
  }
}


var combineWithAuthentication = function(apicall) {

  if (!apicall.authentication) {
    return apicall;
  }

  for (var ap in apicall.authentication.parameters) {
    apicall.parameters[ap] = apicall.authentication.parameters[ap];
  }

  return apicall;

}

module.exports = {
  getRoutes: getRoutes,
  parseRequest: parseRequest,
  getAuthentication: getAuthentication,
  combineWithAuthentication: combineWithAuthentication
}
