var _             = require('lodash')
  , Promise       = require('bluebird')
  , config        = require('config-url')
  , winston       = require('winston')
  , async         = require('async')
  , io_redis      = require('socket.io-redis')
  , socket_io     = require('socket.io')
  , socket_io_jwt = require('socketio-jwt')
  , Log           = require('../db/log')
  , Pub           = require('../db/pub')
  , Sub           = require('../db/sub')
  , { redis }     = require('../db/redis')
  ;

const pub = config.get('jwt.public');

function consume(server) {
  let io = socket_io(server, { httpCompression : true });

  // io.origins([ 'https://www.breadboard.io', 'https://breadboard.io' ]);
  // io.origins((origin, callback) => {
  //   console.log(origin);
  //   // if (origin !== 'https://foo.example.com') {
  //   //   return callback('origin not allowed', false);
  //   // }
  //   callback(null, true);
  // });

  // todo [akamel] is this circular ref bad?
  server.io = io;

  let { host, port }  = config.getUrlObject('tailf.redis')
    , db              = config.get('tailf.redis.db')
    , password        = config.get('tailf.redis.password')
    , requestsTimeout = 200 /*ms*/
    , redis_opts      = { host, port, db, requestsTimeout }
    ;

  if (config.has('tailf.redis.password')) {
    let password = config.get('tailf.redis.password');
    if (!_.isEmpty(password)) {
      redis_opts.password = password;
    }
  }

  io.adapter(io_redis(redis_opts));
  // let red = io_redis({ host, port, db, password, requestsTimeout });
  // io.adapter(red);
  //
  // red.pubClient.debug_mode = true;
  // red.subClient.debug_mode = true;
  io.of('/').adapter.on('error', (err) => {
    console.error('socket.io-redis', err);
  });

  io
    .on('connection', socket_io_jwt.authorize({
        secret    : (request, token, cb) => { cb(null, pub); }
      , timeout   : 5 * 1000 // 15 seconds to send the authentication message
      // , required  : false
      // , callback: false
    }))
    // .on('connection', (a) => {
    //   console.log(a);
    // })
    .on('authenticated', (socket) => {
      let { sub, sub_type, scope } = socket.decoded_token;

      winston.info('authenticated', sub, scope, socket.id);

      const AUTHORIZATION_TIMEOUT = 20 * 1000;

      // todo [akamel] async.timeout and the () => func
      // might cause delay in listen to authorize_write functions
      async.race([
          async.timeout((cb) => {
            socket.on('authorize_write', () => {
              Promise
                .resolve(_.includes(scope, 'write'))
                .then((allow) => {
                  if (!allow) {
                    throw new Error('unauthorized');
                  }
                })
                .tap(() => {
                  Pub.get(socket).then(() => socket.emit('writable'));
                })
                .asCallback(cb)
            })
          }, AUTHORIZATION_TIMEOUT),
          async.timeout((cb) => {
            socket.on('authorize_read', () => {
              Promise
                .resolve(_.includes(scope, 'read'))
                .then((allow) => {
                  if (!allow) {
                    throw new Error('unauthorized');
                  }
                })
                .tap(() => {
                  Sub.get(socket).then(() => socket.emit('readable'));
                })
                .asCallback(cb)
            })
          }, AUTHORIZATION_TIMEOUT)
      ],
      (err, result) => {
        if (err) {
          socket.emit('unauthorized');
          socket.disconnect(true);
        }
      });
    });
}

module.exports = {
    consume
};
