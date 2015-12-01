/***
  Routes controller, of sorts
  All routes logic and management goes here
***/

var _ = require('underscore'),
    fs = require('fs'),
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

    r = fs.readFileSync(r, {
        encoding: 'utf-8'
    });

    try {
        r = JSON.parse(r);
    } catch (e) {
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

    r = fs.readFileSync(r, {
        encoding: 'utf-8'
    });

    try {
        r = JSON.parse(r);
    } catch (e) {
        console.log('Cannot parse routes file as JSON');
        console.log(e);
        process.exit(0);
    }

    return (!_.isUndefined(r.authentication[authentication]) ? r.authentication[authentication] : false);

}

// when request is received, check whether the calls parameters are present
// and match those defined in the routes
var parseRequest = function(apicall, req, res) {

    var opts;

    // post & puts parameters are in req.body, but get parameters are in req.query
    switch (req.route.method) {
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

    // the error messages array
    var errors = validate.parameters(apicall, opts, req.files);

    // if there are some errors
    if (errors.messages.length) {

        // return 200 and the errors
        return res.send(200, {
            "success": false,
            "error": errors
        });

    }

    delegate(apicall, opts, req, res);

}

var delegate = function(apicall, opts, req, res) {

    // if there is a call back for this API call
    if (apicall.callback && apicall.library) {

        var series = {};

        // do the authentication request, if required
        if (apicall.authentication) {
            series.auth = function(callback) {

                var auth_lib = require(apicall.authentication.library);

                auth_lib[apicall.authentication.callback](opts,
                    function(err, data, exposed) {
                        var returnData = data;

                        if(exposed) {
                            returnData = {
                                _isExposed: true,
                                data: data,
                                _exposed: exposed
                            };
                        }

                        return callback(err, returnData);
                    },
                    {
                        req: req,
                        res: res
                    }
                );
            }
        }

        // process the API call
        series.request = function(callback) {

            var lib = apicall.library.split("/");
            var cachekey = [lib[lib.length - 1], apicall.callback];

            var keys = Object.keys(opts);
            keys.sort();

            for (var k in keys) {

                if (keys[k] == '_use_cache') {
                    continue;
                }

                cachekey.push(keys[k]);
                cachekey.push((opts[keys[k]] ? opts[keys[k]] : ""));
            }

            cachekey = cachekey.join("");

            caching.get((opts._use_cache ? apicall.caching : false),
                cachekey,
                function(err, cached) {

                    // didn't get anything from cache
                    if (err || _.isNull(cached)) {

                        // load the library
                        var lib = require(apicall.library);

                        // call the callback
                        lib[apicall.callback](opts,
                            function(err, data, exposed) {
                                var returnData = data;

                                if(exposed) {
                                    returnData = {
                                        _isExposed: true,
                                        data:       data,
                                        _exposed:   exposed
                                    };
                                }

                                // store retrieved value in cache if no error
                                if (apicall.cache !== false && !err) {
                                    caching.set(apicall.caching, cachekey, returnData);
                                }

                                return callback(err, returnData);

                            },
                            {
                                req: req,
                                res: res
                            });

                    }

                    // did get from cache
                    else {
                        console.log('got from cache', cachekey)
                        return callback(null, cached);
                    }
                }
            );
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
                var resultData;

                // check if there is an extra "exposed" object in the results from "auth"
                if (result.auth !== null &&
                    typeof result.auth === 'object' &&
                    result.auth._isExposed &&
                    result.auth.hasOwnProperty('_exposed')
                ) {
                    var authExposed = result.auth._exposed;

                    // process any cookies to be set by the auth function
                    if (authExposed.setCookies) {
                        for (var c in authExposed.setCookies) {
                            var cook = authExposed.setCookies[c];
                            res.cookie(cook.name, cook.value, cook.options);
                        }
                    }
                }

                // check if there is an extra "exposed" object in the results from "request"
                if (result.request !== null &&
                    'object' === typeof result.request &&
                    result.request._isExposed &&
                    result.request.hasOwnProperty('data') &&
                    result.request.hasOwnProperty('_exposed')) {

                    var requestExposed  = result.request._exposed;
                    resultData          = result.request.data;

                    // process any cookies to be set by the request function
                    // this can potentially overwrite any set by the auth function
                    if (requestExposed.setCookies) {
                        for (var c in requestExposed.setCookies) {
                            var cook = requestExposed.setCookies[c];
                            res.cookie(cook.name, cook.value, cook.options);
                        }
                    }

                    if (requestExposed.responseType) {
                        switch (requestExposed.responseType) {
                            case 'file':
                                res.sendFile(requestExposed.filename);
                                break;
                            case 'download':
                                res.download(requestExposed.filename);
                                break;
                            case 'redirect':
                                res.redirect(
                                    requestExposed.redirectCode,
                                    requestExposed.redirectTo
                                );
                                break;
                        };

                        return;
                    }
                }
                else {
                    resultData = result.request;
                }

                var sendResponse;

                // send the response back to the client
                if (apicall.rawResponse) {
                    sendResponse = resultData;
                } else {
                    sendResponse = {
                        "success": true,
                        "data": resultData
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
