'use strict';

var _redis = require("../../utils/redis-helper"),
    _ = require("lodash"),
    $q = require("q"),
    _helper = require("../../utils/helper");

var io;
var cache = _redis.cache;

require('../../utils/socket.io-helper').get_socket_io().then(function(_io) {
    // console.log('redis.js 에서 가져온 socket.io 객체:', _io);

    io = _io.of('/redis');
    io.on('connection', function(socket){
      console.log('REDIS: someone connected to redis group');

      io.emit('hi', 'everyone!');

      _redis.doMonitor(function(err, res) {
          console.log("MONITOR: Entering monitoring mode.");
      }, function(time, args) {
          console.log('MONITOR: ' + time + ": " + args[0]);
          io.emit('redis', JSON.stringify(args, null,2));
      });
    });
});



/**
 * 요건 restful API 지원을 위한 더미 exports
 * 실제로는 아래 exports.rest 가 호출 됨. (관련 로직은 interceptor.js 에서 처리)
 */
exports['rest/:'] = function (req, res) {
    res.send('WOW');
}



/**
 * READ
 */
function restGET(projectName, path) {
    var deferred = $q.defer();
    var targetKey = path.split('>');

    _redis.redisHGET(projectName, path).then(function (hash) {
        try {
            var datas = _helper.hashToJSON(hash);

            // console.log(JSON.stringify(datas, null,2));
            _helper.objectToJSON(datas);  // 하위요소까지 배열은 배열로 치환

            setTimeout(function() {
                datas = datas[projectName];
                var i,
                    len = targetKey.length;

                for (i=0; i<len; i++) {
                    // console.log('@@@@@@ targetKey[' + i + ']:' + targetKey[i]);

                    if (datas[targetKey[i]]) {  // 객체가 바로 있는경우 객체 할당
                        datas = datas[targetKey[i]];
                    } else if (datas.length === 1 && targetKey[i] !=='') { // 배열이고, length 가 1인경우 0번째 배열 할당
                        i++;
                        datas = datas[0];
                    }
                }

                deferred.resolve(datas);
            });
        } catch(e) {
            deferred.reject('restGET 데이터처리 err: ' + e.message);
        }
    }, function (err) {
        deferred.reject('restGET redisHGET res err: ' + err);
    });

    return deferred.promise;
}

/**
 * CREATE
 */
function restPOST(projectName, key, req) {
    var deferred = $q.defer();
    var targetKey = key.split('>');
    var body = req.body;
    var _key;


    if (req.headers['content-type'].toLowerCase() !== 'application/json') {
        deferred.reject('content-type is not application/json');

    } else if (key === projectName + '>') {
        deferred.reject('too risky request (POST method는 최상위 요소에서 허용되지 않습니다. 입력하고자 하는 하위요소 키와함께 요청하세요.)');
    } else {

        _redis.redisHGET(projectName, key).then(function (hash) {   // STEP1. 데이터 있는지 체크
            var datas = _helper.hashToJSON(hash);
            console.log('restPOST 기존 데이터가 있어서 restPUT 으로 위임');

            try {
                restPUT(projectName, key, req).then(function(response) {
                    deferred.resolve(response)
                }, function(err) {
                    deferred.reject(err);
                });
            } catch(e) {
                console.log('restPOST err:' + e.message);
                deferred.reject(e.message);
            }
        }, function (err) { // STEP2. 데이터 없는 경우처리

            try {

                // STEP2-1. 상위 요소가 배열인지 아닌지 체크
                targetKey = targetKey.splice(0, targetKey.length-2).join('>');

                var path = key,
                    t;

                // redis key에 배열인 경우 상위 부모키에 keyname@ 와 같이 @를 postfix 로 붙이고 있어 이를 매칭하기 위해 pathRegex 사용
                var cc = cache[projectName],
                    i,
                    len = cc.length,
                    pathRegex = _helper.getKeyRegexp(targetKey);

                for (i=0; i<len; i++) {
                    _key = cc[i];
                    // console.log(_key);
                    if (!pathRegex.test(_key + '>')) {   // 비교 시 실제 키에 > 를 강제로 붙여줌!
                        continue;
                    }

                    t = _key;
                    break;
                }

                var max = 0;
                // console.log("XXXXX: " + targetKey);

                if (!t) {   // 해당키에 대한 요소를 찾지 못함.

                    if (key.split('>').length === 3) {  // 최사위 요소님
                        var newTarget = _key.split('>')[0] + '>' + key.split('>')[1];

                        _helper.objectToHashKeyPair(body, newTarget).then(function(newHash) {
                            try {
                                var tmp,
                                    k2;
                                console.log('create newHash', newHash);

                                // deferred.resolve(newHash);
                                _redis.redisHMSET(projectName, key, newHash).then(function(o) {
                                    console.log('WOW POST CREATE SUCCESS:', JSON.stringify(o,null,2));
                                    deferred.resolve(newHash);

                                    _redis.redisHKEYS(projectName);    // 신귫 추가 했으니 키를 업데이트 해줌
                                }, function(err) {
                                    deferred.reject(err);
                                });
                            } catch(e) {
                                console.log('restPOST ERR 2:' + e.message);
                                deferred.reject('restPOST ERR 2:' + e.message);
                            }

                        });
                    } else {
                        deferred.reject('해당키에 대한 요소를 찾지 못함 key:' + key + ' ,' + _key);
                    }


                } else if (t.replace(targetKey, '').substring(0,1) === '@') {  // 상위요소가 배열이라면 max 인덱스 값으로 INSERT
                    for (i=0; i<len; i++) {
                        _key = cc[i];
                        if (!pathRegex.test(_key + '>')) {   // 비교 시 실제 키에 > 를 강제로 붙여줌!
                            continue;
                        }

                        t = parseInt(_key.replace(targetKey+'@>', '').split('>')[0], 10);
                        max = t > max ? t : max;
                    }


                    var newTarget = projectName + '@>' + (max+1);
                    _helper.objectToHashKeyPair(body, newTarget).then(function(newHash) {
                        try {
                            var tmp,
                                k2;
                            console.log('create newHash', newHash);

                            _redis.redisHMSET(projectName, key, newHash).then(function(o) {
                                console.log('WOW POST CREATE SUCCESS:', JSON.stringify(o,null,2));
                                deferred.resolve(newHash);

                                _redis.redisHKEYS(projectName);    // 신귫 추가 했으니 키를 업데이트 해줌
                            }, function(err) {
                                deferred.reject(err);
                            });
                        } catch(e) {
                            console.log('restPOST ERR 2:' + e.message);
                            deferred.reject('restPOST ERR 2:' + e.message);
                        }

                    });
                } else {

                    // var l = path.split('>'),
                    //     tmp = t.split('>'),
                    //     newTarget = tmp.splice(0, l.length-2).join('>') + '>' + l[2];

                    var newTarget = _helper.getRealKeyPrefix(t, path);

                    _helper.objectToHashKeyPair(body, newTarget).then(function(newHash) {
                        try {
                            var tmp,
                                k2;

                            console.log('create newHash', newHash);

                            // deferred.resolve(newHash);
                            _redis.redisHMSET(projectName, key, newHash).then(function(o) {
                                console.log('WOW POST CREATE SUCCESS:', JSON.stringify(o,null,2));
                                deferred.resolve(newHash);

                                _redis.redisHKEYS(projectName);    // 신귫 추가 했으니 키를 업데이트 해줌
                            }, function(err) {
                                deferred.reject(err);
                            });
                        } catch(e) {
                            console.log('restPOST ERR 2:' + e.message);
                            deferred.reject('restPOST ERR 2:' + e.message);
                        }

                    });

                    // deferred.reject('추가할 수 없는 구조입니다. (해당 요소가 존재하지 않고, 상위요소가 배열이 아님)');
                }
            } catch(ee) {

                deferred.reject('restPOST ERR 1' + ee.message + ' with ' + projectName + ',' + key + ' targetKey:' + targetKey);
                console.log('restPOST ERR 1' + ee.message);
            }
        });
    }

    return deferred.promise;
}

/**
 * UPDATE
 */
function restPUT(projectName, key, req) {

    try {
        var deferred = $q.defer(),
            body = req.body,
            isBodyArray = _.isArray(body);


        if (req.headers['content-type'].toLowerCase() !== 'application/json') {
            deferred.reject('content-type is not application/json');

        } else if (key === projectName + '>') {
            deferred.reject('too risky request (PUT method는 최상위 요소에서 허용되지 않습니다.)');

        } else {
            // 값이 있는지 체크
            _redis.redisHGET(projectName, key).then(function (hash) {

                if (!hash) {
                    deferred.reject('NOT FOUND key: ' + key);
                } else {

                    try {
                        var k,
                            oOld = {},
                            oOldCouldBeDelete = [],
                            oNew = {},
                            oFinal = {},
                            oFinalNew,
                            oFinalDel = [];

                        var subRoot;

                        for (k in hash) {
                            // regexp = _helper.getKeyRegexp(k);
                            oOld[k.replace(/@/g,'')] = {
                                key: k,
                                val: hash[k]
                            }

                            if (!subRoot) {
                                subRoot = _helper.getRealKeyPrefix(k, key, isBodyArray);
                            }
                        }

                        // console.log('oOld:', JSON.stringify(oOld, null, 2));
                        // if (_.isArray(body)) {
                        //     console.log('이넘 배열이야!!', subRoot);
                        // }

                        var tmpPrefix = isBodyArray ? subRoot : projectName;    // 배열인 경우에는 subRoot 를 prefix로 붙인다.
                        _helper.objectToHashKeyPair(body, tmpPrefix).then(function(bodyHash) {
                            try {
                                var tmp,
                                    k2,
                                    count = 0,
                                    isNew;

                                console.log('bodyHash', bodyHash);


                                for (k2 in bodyHash) {
                                    isNew = true;
                                    if (isBodyArray) {
                                        tmp = k2.replace(/@/g,'');
                                    } else {
                                        tmp = k2.replace(projectName + '>', key).replace(/@/g,'');
                                    }
                                    oNew[tmp] = bodyHash[k2];

                                    // console.log('XXXXX',tmp, k);
                                    for (k in oOld) {
                                        // if (/coordinates/.test(k)) {
                                                // console.log('XXXX', k, tmp, '???', projectName,key, k2, "XXx:", projectName + '>', key);
                                        //  }
                                        if (k + '>' === tmp + '>') {
                                            //  console.log('XXXXX', k + '>' , tmp + '>');
                                            oFinal[oOld[k].key] = bodyHash[k2];
                                            isNew = false;
                                            count++;
                                        } else if (new RegExp(tmp + '>').test(k + '>')) {   // 스키마변경! 스트링 값이 오브젝트 형태로 스키마변경된 케이스.
                                            console.log('기존키와 동일하진 않지만 같은 그룹인 경우:', tmp, k);

                                            if (subRoot) {
                                                // console.log(subRoot.replace(/@/g,''), subRoot, k);
                                                k = k.replace(subRoot.replace(/@/g,''), subRoot);
                                            }

                                            console.log('요기소 DEL 추가됐나???' , k);
                                            oFinalDel.push(k);
                                        }
                                    }


                                    // 스키마변경! 스트링 값이 오브젝트 형태로 스키마 변경된 케이스로. 기존 스트링키를 삭제하고자함
                                    tmp = key + k2.replace(projectName + '>', '').split('>')[0];

                                    // console.log(cache[projectName]);
                                    // console.log(k2 + ' 키가 존재하니? ', cache[projectName].indexOf(tmp));
                                    if (cache[projectName].indexOf(tmp) !== -1 && typeof oFinal[tmp] === 'undefined') {

                                        if (subRoot) {
                                            tmp = tmp.replace(subRoot.replace(/@/g,''), subRoot);
                                        }

                                        oFinalDel.push(tmp);
                                    }

                                    if (isNew) {
                                        if (!oFinalNew) { oFinalNew = {}; }

                                        tmp = k2.replace(projectName + '>', key);
                                        if (subRoot) {
                                            // console.log('>>>>>>>> ' + tmp + ' to ' + subRoot);
                                            tmp = tmp.replace(subRoot.replace(/@/g,''), subRoot);
                                        }
                                        // console.log('새로운키 추가정보:', tmp);
                                        oFinalNew[tmp] = bodyHash[k2];
                                    }

                                }

                                for (k in oOld) {
                                    if (typeof oFinal[oOld[k].key] === 'undefined') {
                                        // console.log('삭제가능한 기존 키', k);
                                        oOldCouldBeDelete.push(oOld[k].key);
                                    }
                                }

                                if (oFinalDel.length>0) {
                                    var i,
                                        len = oFinalDel.length,
                                        j,
                                        lenj = oOldCouldBeDelete.length;
                                    for (i=0; i<len; i++) {
                                        for (j=0; j<lenj; j++) {
                                            if (_helper.getKeyRegexp(oFinalDel[i]).test(oOldCouldBeDelete[j] +'>')) {
                                                 console.log('실제 삭제키 찾기 (찾았당!)', oFinalDel[i], j, oOldCouldBeDelete[j]);

                                                oFinalDel[i] = oOldCouldBeDelete[j];
                                                break;
                                            }

                                        }
                                    }
                                } else {
                                    var j,
                                        lenj = oOldCouldBeDelete.length;

                                    for (j=0; j<lenj; j++) {
                                        // @iolothebard 님의 가르침에 따라 모두 삭제하장 ㅋㅋㅋ
                                        // var _old_key = oOldCouldBeDelete[j];
                                        // console.log('kkkkkk', _old_key);
                                        // for (k in oFinalNew) {
                                        //      console.log('강제 삭제필요 확인:', k, 'vs', _old_key);
                                        //     if (k.indexOf(_old_key) !== -1) {
                                        //         console.log('삭제해야함! (일반 스트링 또는 객체에서 배열로 바뀌는 경우)', _old_key);
                                        //         oFinalDel.push(_old_key);
                                        //         break;
                                        //     } else if (_old_key.substring(0, _old_key.lastIndexOf('>')) === k.substring(0, k.lastIndexOf('>')) + '@') {
                                        //         console.log('삭제해야함! (배열에서 일반 스트링 또는 객체로 바뀌는 경우)', _old_key);
                                        //         oFinalDel.push(_old_key);
                                        //         break;
                                        //     }
                                        // }
                                        oFinalDel.push(oOldCouldBeDelete[j]);
                                    }
                                }

                                console.log('oFinal (for Update): ', JSON.stringify(oFinal, null, 2),
                                    'oFInalNew: ', JSON.stringify(oFinalNew, null, 2),
                                    'FinalDel: ', JSON.stringify(oFinalDel, null, 2),
                                    'SUBROOT: ', subRoot);


// deferred.resolve('');
// return;
                                // console.log(
                                //     'oFInalNew: ', JSON.stringify(oFinalNew, null, 2),
                                //     'FinalDel: ', JSON.stringify(oFinalDel, null, 2));

                                // 응답 포맺:
                                // response = {
                                //   new: [...],    // 새로 추가될 key 목록
                                //   delete: [...], // 삭제될 키 목록
                                //   update: [...]  // 업데이트 될 키 목록
                                // }
                                var response = {};


                                // for debug
                                // console.log('oOldCouldBeDelete', oOldCouldBeDelete);
                                // deferred.resolve(oFinalDel);

                                _redis.redisHDEL(projectName, (oFinalDel.length === 0 ? null : oFinalDel)).then(function() {
                                    if (oFinalDel.length>0) {
                                        response.delete = oFinalDel;
                                    }
                                    if (count === 0) {  // 업데이트할 내용이 없음. 아마 신규로 create해야할듯... (restPOST 에서 위임된 케이스도 많을듯.)
                                        console.log('업데이트할 내용이 없음. 아마 신규로 create해야할듯... (restPOST 에서 위임된 케이스도 많을듯.)');

                                        _redis.redisHMSET(projectName, key, oFinalNew).then(function(o) {
                                            console.log('WOW PUT CREATE SUCCESS:', JSON.stringify(o,null,2));
                                            response.new = oFinalNew;
                                            _redis.redisHKEYS(projectName);
                                            deferred.resolve(response);
                                        }, function(err) {
                                            deferred.reject(err);
                                        });

                                    } else {
                                        _redis.redisHMSET(projectName, key, oFinal).then(function(o) {
                                            // console.log('WOW PUT UPDATE SUCCESS:', JSON.stringify(o,null,2));
                                            response.update = oFinal;
                                            if (oFinalNew) {    // 업데이트하고 추가된 키 처리
                                                _redis.redisHMSET(projectName, key, oFinalNew).then(function(o) {
                                                    // console.log('WOW PUT UPDATE SUCCESS:', JSON.stringify(o,null,2));
                                                    response.new = oFinalNew;
                                                    _redis.redisHKEYS(projectName);
                                                    deferred.resolve(response);
                                                }, function(err) {
                                                    deferred.reject('기존 키는 업데이트 성공하였으나 새로운 삽입도중 오류발생 (' + err + ')');
                                                });
                                            } else {
                                                _redis.redisHKEYS(projectName);
                                                deferred.resolve(response);
                                            }

                                        }, function(err) {
                                            deferred.reject(err);
                                        });
                                    }

                                });



                            } catch(e) {
                                console.log('restPUT ERR 2:' + e.message);
                                deferred.reject('restPUT ERR 2:' + e.message);
                            }

                        });
                    } catch(e) {
                        console.log('restPUT ERR 1:' + e.message);
                        deferred.reject('restPUT ERR 1:' + e.message);
                    }

                }
            }, function(error) {
                deferred.reject(error);
            });
        }
    } catch(e) {
        console.log('restPUT ERR 0:' + e.message);
        deferred.reject('restPUT ERR 0:' + e.message);
    }

    return deferred.promise;
}


/**
 * DELETE
 */
function restDELETE (projectName, key, req) {
    var deferred = $q.defer();

        // 값이 있는지 체크
        _redis.redisHGET(projectName, key).then(function (hash) {
            try {

                if (!hash) {
                    deferred.reject('NOT FOUND key: ' + key);
                } else {
                    try {
                        var k,
                            keys = [];
                        for (k in hash) {
                            keys.push(k);
                        }

                        _redis.redisHDEL(projectName, keys).then(function(res) {
                            deferred.resolve(res);
                            _redis.redisHKEYS(projectName);    // 삭제 했으니 키를 업데이트 해줌
                        }, function(err) {
                            deferred.reject('restDELETE ERR: ' + err);
                        });

                    } catch(e) {
                        console.log('restDELETE ERR 1:' + e.message);
                        deferred.reject('restDELETE ERR 1:' + e.message);
                    }

                }
            } catch(e) {
                console.log('restDELETE ERR 0:' + e.message);
                deferred.reject('restDELETE ERR 0:' + e.message);
            }

        }, function(error) {
            deferred.reject(error);
        });


    return deferred.promise;
}

/**
 * @examples
 * // GET
 * http://localhost:10000/service/redis/rest?path=test-libs>강남구>library
 * http://localhost:10000/service/redis/rest?path=test-libs>강남구>library/0
 * http://localhost:10000/service/redis/rest/test-libs/강남구/library
 * http://localhost:10000/service/redis/rest/test-libs/강남구/library/0
 */
exports.rest = function (req, res) {
    var path,
        projectName;

    if (req.query._pathParam) {
        path = decodeURIComponent(req.query._pathParam).replace(/\//g, '>');
    } else if (req.query.path) {
        path = req.query.path || '';
    } else {
        path = req._parsedUrl.pathname.replace(/^\/rest\//, '').replace(/\//g, '>');
    }

    console.log('path:' + path);
    path = path + (path.substring(path.length-1, path.length) === '>' ? '' : '>');
    projectName = path.substring(0, path.indexOf('>')).replace('@', '');

    console.log('@@ METHOD:', req.method, 'REDIS PATH:', path, 'REDIS PROJECT:', projectName);

    if (!projectName) {
        res.send('NO PROJECT FOUND');
    }

    // RESTAPI 참조: http://www.restapitutorial.com/lessons/httpmethods.html
    switch(req.method) {
        case 'GET': // READ
            restGET(projectName, path).then(
                function (data) { res.send(successCallback(data)); },
                function (err) { res.send(errorCallback(err)); }
            );
            break;
        case 'POST': // CREATE
            restPOST(projectName, path, req).then(
                function (data) { res.send(successCallback(data)); },
                function (err) { res.send(errorCallback(err)); }
            );
            break;
        case 'PUT': // UPDATE
            restPUT(projectName, path, req).then(
                function (data) { res.send(successCallback(data)); },
                function (err) { res.send(errorCallback(err)); }
            );

            break;
        case 'DELETE': // DELETE
            restDELETE(projectName, path, req).then(
                function (data) { res.send(successCallback(data)); },
                function (err) { res.send(errorCallback(err)); }
            );
            break;
    }
};



function successCallback (data) {
    var response = {
        code: 'SUCCESS',
        data: data
    };

    if (typeof data !== 'string' && data.length) {
        response.count = data.length;
    }

    return response;
}

function errorCallback (err) {
    return {
        code: 'FAIL',
        message: err
    };
}