var async         = require('async');
var commander     = require('commander');
var crypto        = require('crypto');
var express       = require('express');
var isRunning     = require('is-running')
var magnetUri     = require('magnet-uri');
var merge         = require('merge');
var mime          = require('mime');
var mixpanel      = require('mixpanel');
var os            = require('os');
var pump          = require('pump');
var rangeParser   = require('range-parser');
var request       = require('request');
var streamMeter   = require("stream-meter");
var torrentStream = require('torrent-stream');

// ----------------------------------------------------------------------------

var PRELOAD_RATIO = 0.005;

// ----------------------------------------------------------------------------

commander
  .version('0.1.2')
  .option('-p, --port <port>', 'HTTP server port [8042]', Number, 8042)
  .option('-k, --keep', 'Keep downloaded files upon stopping')
  .option('-i, --ppid <ppid>', 'Parent PID to monitor for auto-shutdown', Number, -1)
  .option('-a, --inactivity-pause-timeout <timeout>', 'Torrents will be paused after some inactivity', Number, 10)
  .option('-r, --inactivity-remove-timeout <timeout>', 'Torrents will be removed after some inactivity', Number, 20)
  .option('-t, --mixpanel-token <token>', 'Mixpanel token')
  .option('-d, --mixpanel-data <data>', 'Mixpanel data')
  .parse(process.argv);

// ----------------------------------------------------------------------------

var publicIP = undefined;

function trackingPeopleSet() {
  if (commander.mixpanelToken) {
    var properties = { 'Server OS': os.platform(), 'Server Arch': os.arch() };

    if (commander.mixpanelData)
      properties = merge(properties, JSON.parse(new Buffer(commander.mixpanelData, 'base64').toString()));

    getDistinctId(function(distinctId) {
      mixpanel.init(commander.mixpanelToken).people.set(distinctId, properties);
    });
  }
}

function trackingEvent(name, properties, additionalData) {
  if (commander.mixpanelToken) {
    properties = merge(properties, { 'Server OS': os.platform(), 'Server Arch': os.arch() });

    if (commander.mixpanelData)
      properties = merge(properties, JSON.parse(new Buffer(commander.mixpanelData, 'base64').toString()));

    if (additionalData)
      properties = merge(properties, JSON.parse(new Buffer(additionalData, 'base64').toString()));

    getDistinctId(function(distinctId) {
      properties['distinct_id'] = distinctId;
      mixpanel.init(commander.mixpanelToken).track(name, properties);
    });
  }
}

function getDistinctId(callback) {
  getPublicIP(function(publicIP) {
    callback(crypto.createHash('sha1').update(os.platform() + os.arch() + publicIP).digest('hex'));
  });
}

function getPublicIP(callback) {
  if (!publicIP) {
    request('http://myexternalip.com/raw', function(error, response, body) {
      if (!error && response.statusCode == 200) {
        publicIP = body;
        callback(publicIP);
      }
    });
  } else {
    callback(publicIP);
  }
}

// ----------------------------------------------------------------------------

var app      = express();
var torrents = {};

app.set('json spaces', 2);

app.get('/', function(req, res) {
  var result = [];
  for (var infoHash in torrents)
    result.push(torrents[infoHash].getInfo());
  res.json(result);
});

app.get('/shutdown', function(req, res) {
  shutdown();
});

app.get('/add', function(req, res) {
  var torrent = addTorrent(req.query.magnet_link, req.query.download_dir || '.', req.query.mixpanel_data);

  torrent.addConnection();

  req.on("close", function() {
    torrent.removeConnection();
  });

  req.on("end", function() {
    torrent.removeConnection();
  });

  res.json(torrent.getInfo());
});

app.get('/video', function(req, res) {
  var torrent = addTorrent(req.query.magnet_link, req.query.download_dir || '.', req.query.mixpanel_data);

  torrent.addConnection();

  req.on("close", function() {
    torrent.removeConnection();
  });

  req.on("end", function() {
    torrent.removeConnection();
  });

  switch (torrent.state) {
    case 'downloading':
    case 'finished':
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', mime.lookup.bind(mime)(torrent.mainFile.name));
      res.setHeader('transferMode.dlna.org', 'Streaming');
      res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=017000 00000000000000000000000000');

      var range = req.headers.range;
      range = range && rangeParser(torrent.mainFile.length, range)[0];

      torrent.meter = streamMeter();
      torrent.meterInterval = setInterval(function() {
        if (torrent.meter.bytes > (10 * 1024 * 1024)) {
          clearInterval(torrent.meterInterval);
          if (!torrent.serving) {
            torrent.serving = true;
            console.log('[scrapmagnet] ' + torrent.dn + ': SERVING');
            trackingEvent('Serving', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
          }
        }
      }, 1000);

      if (!range) {
        res.setHeader('Content-Length', torrent.mainFile.length);
        pump(torrent.mainFile.createReadStream(), torrent.meter, res);
      } else {
        res.status(206);
        res.setHeader('Content-Length', range.end - range.start + 1);
        res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + torrent.mainFile.length);
        pump(torrent.mainFile.createReadStream(range), torrent.meter, res);
      }

      break;
    case 'failed':
      res.sendStatus(404);
      break;
    case 'metadata':
      setTimeout(function() {
        res.redirect(307, req.url);
      }, 1000);
      break;
  }
});

function addTorrent(magnetLink, downloadDir, mixpanelData) {
  var magnetData = magnetUri.decode(magnetLink);

  if (!(magnetData.infoHash in torrents)) {
    var torrent = {
      engine:       torrentStream(magnetLink, { path: downloadDir }),
      dn:           magnetData.dn,
      infoHash:     magnetData.infoHash,
      mixpanelData: mixpanelData,
      state:        'metadata',
      connections:  0,
      paused:       false,
      pieceMap:     [],
    };

    torrent.addConnection = function() {
      this.connections++;
      // console.log('[scrapmagnet] ' + this.dn + ': CONNECTION ADDED: ' + this.connections);

      if (this.mainFile && this.paused) {
        this.mainFile.select();
        this.paused = false;
        console.log('[scrapmagnet] ' + this.dn + ': RESUMED');
      }

      clearTimeout(this.pauseTimeout);
      clearTimeout(this.removeTimeout);
    };

    torrent.removeConnection = function() {
      this.connections--;
      // console.log('[scrapmagnet] ' + this.dn + ': CONNECTION REMOVED: ' + this.connections);

      if (this.connections == 0) {
        var self = this;
        this.pauseTimeout = setTimeout(function() {
          if (self.mainFile && !self.paused) {
            self.mainFile.deselect();
            self.paused = true;
            console.log('[scrapmagnet] ' + self.dn + ': PAUSED');
          }
          self.removeTimeout = setTimeout(function() {
            self.destroy();
          }, commander.inactivityRemoveTimeout * 1000);
        }, commander.inactivityPauseTimeout * 1000);
      }

      clearTimeout(this.servingTimeout);
    };

    torrent.getInfo = function() {
      var info = {
        dn:             this.dn,
        info_hash:      this.infoHash,
        state:          this.state,
        paused:         this.paused,
        downloaded:     this.engine.swarm.downloaded,
        uploaded:       this.engine.swarm.uploaded,
        download_speed: this.engine.swarm.downloadSpeed() / 1024,
        upload_speed:   this.engine.swarm.uploadSpeed() / 1024,
        peers:          this.engine.swarm.wires.length,
      };

      if (this.state == 'downloading' || this.state == 'finished') {
        info.files = [];

        var self = this;
        this.engine.files.forEach(function(file) {
          info.files.push({ path: file.path, size: file.length, main: (file.path == self.mainFile.path) });
        });

        info.pieces         = this.engine.torrent.pieces.length;
        info.pieces_preload = Math.round(info.pieces * PRELOAD_RATIO);
        info.piece_length   = this.engine.torrent.pieceLength;
        info.piece_map      = Array(Math.ceil(info.pieces / 100));

        for (var i = 0; i < info.piece_map.length; i++)
          info.piece_map[i] = '';

        for (var i = 0; i < info.pieces; i++)
          info.piece_map[Math.floor(i / 100)] += this.pieceMap[i];

        info.video_ready = this.pieceMap[info.pieces - 1] == '*';
        for (var i = 0; i < info.pieces_preload; i++) {
          if (this.pieceMap[i] != '*') {
            info.video_ready = false;
          }
        }
      }

      return info;
    };

    torrent.engine.on('verify', function(pieceIndex) {
      torrent.pieceMap[pieceIndex] = '*';
    });

    torrent.engine.on('idle', function() {
      if (torrent.state == 'downloading' && !torrent.paused) {
        torrent.state = 'finished';

        console.log('[scrapmagnet] ' + torrent.dn + ': FINISHED');
        trackingEvent('Finished', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
      }
    });

    torrent.destroy = function(callback) {
      var self = this;
      this.engine.destroy(function() {
        console.log('[scrapmagnet] ' + self.dn + ': REMOVED');
        trackingEvent('Removed', { 'Magnet InfoHash': self.infoHash, 'Magnet Name': self.dn }, self.mixpanelData);
        if (!commander.keep) {
          self.engine.remove(function() {
            console.log('[scrapmagnet] ' + self.dn + ': DELETED');
            delete torrents[self.infoHash];
            if (callback)
              callback();
          });
        } else {
          delete torrents[self.infoHash];
          if (callback)
            callback();
        }
      });
    };

    torrent.engine.on('ready', function() {
      torrent.state = 'downloading';

      // Select main file
      torrent.engine.files.forEach(function(file) {
        if (!torrent.mainFile || torrent.mainFile.length < file.length)
          torrent.mainFile = file;
      });
      torrent.mainFile.select();
      torrent.engine.select(0, Math.round(torrent.engine.torrent.pieces.length * PRELOAD_RATIO), true);
      torrent.engine.select(torrent.engine.torrent.pieces.length - 1, torrent.engine.torrent.pieces.length - 1, true);

      // Initialize piece map
      for (var i = 0; i < torrent.engine.torrent.pieces.length; i++)
        if (!torrent.pieceMap[i])
          torrent.pieceMap[i] = '.';

      clearTimeout(torrent.metadataTimeout);
      console.log('[scrapmagnet] ' + torrent.dn + ': METADATA RECEIVED');
      trackingEvent('Metadata received', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
    });

    torrent.metadataTimeout = setTimeout(function() {
      torrent.state = 'failed';
      console.log('[scrapmagnet] ' + torrent.dn + ': METADATA FAILED');
      trackingEvent('Metadata failed', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
    }, 20000);

    torrents[torrent.infoHash] = torrent;

    console.log('[scrapmagnet] ' + torrent.dn + ': ADDED');
    trackingEvent('Added', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
  }

  return torrents[magnetData.infoHash];
}

// ----------------------------------------------------------------------------

if (commander.ppid != -1)
  setInterval(function() {
    if (!isRunning(commander.ppid))
      shutdown();
  });

process.on('SIGINT', function() {
  shutdown();
});

function shutdown() {
  async.forEachOf(torrents,
    function(value, key, callback) {
      value.destroy(callback);
    },
    function() {
      console.log('[scrapmagnet] Stopping');
      process.exit();
    }
  );
}

var server = app.listen(commander.port, function() {
  console.log('[scrapmagnet] Starting on port %s', commander.port);
  trackingPeopleSet();
});
