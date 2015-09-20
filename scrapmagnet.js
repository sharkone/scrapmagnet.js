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
var torrentStream = require('torrent-stream');

// ----------------------------------------------------------------------------

commander
  .version('0.1.0')
  .option('-p, --port <port>', 'HTTP server port [8042]', Number, 8042)
  .option('-k, --keep', 'Keep downloaded files upon stopping')
  .option('-i, --ppid <ppid>', 'Parent PID to monitor for auto-shutdown', Number, -1)
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

  if (torrent.ready)
  {
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mime.lookup.bind(mime)(torrent.mainFile.name));
    res.setHeader('transferMode.dlna.org', 'Streaming');
    res.setHeader('contentFeatures.dlna.org', 'DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=017000 00000000000000000000000000');

    var range = req.headers.range;
    range = range && rangeParser(torrent.mainFile.length, range)[0];

    if (!range) {
      res.setHeader('Content-Length', torrent.mainFile.length);
      pump(torrent.mainFile.createReadStream(), res);
    } else {
      res.statusCode = 206
      res.setHeader('Content-Length', range.end - range.start + 1);
      res.setHeader('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + torrent.mainFile.length);
      pump(torrent.mainFile.createReadStream(range), res);
    }
  } else {
    setTimeout(function() {
      res.redirect(307, req.url);
    }, 1000);
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
      ready:        false,
      paused:       false,
      pieceMap:     [],
      finished:     false,
      connections:  0,

      destroy: function() {
        var self = this;
        this.engine.destroy(function() {
          console.log('[scrapmagnet] ' + self.dn + ': REMOVED');
          trackingEvent('Removed', { 'Magnet InfoHash': self.infoHash, 'Magnet Name': self.dn }, self.mixpanelData);
          if (!commander.keep) {
            self.engine.remove(function() {
              console.log('[scrapmagnet] ' + self.dn + ': DELETED');
            });
          }
        });
        delete torrents[this.infoHash];
      },

      addConnection: function() {
        if (this.pauseTimeout) {
          clearTimeout(this.pauseTimeout);
          this.pauseTimeout = undefined;

          if (this.mainFile && this.paused) {
            this.mainFile.select();
            this.paused = false;
            console.log('[scrapmagnet] ' + this.dn + ': RESUMED');
          }
        }

        if (this.removeTimeout) {
          clearTimeout(this.removeTimeout);
          this.removeTimeout = undefined;
        }

        this.connections++;
      },

      removeConnection: function() {
        if (this.connections > 0) {
          this.connections--;
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
              }, 60000);
            }, 10000);
          }
        }
      },

      getInfo: function() {
        var info = {
          dn:             this.dn,
          info_hash:      this.infoHash,
          ready:          this.ready,
          paused:         this.paused,
          downloaded:     this.engine.swarm.downloaded,
          uploaded:       this.engine.swarm.uploaded,
          download_speed: this.engine.swarm.downloadSpeed() / 1024,
          upload_speed:   this.engine.swarm.uploadSpeed() / 1024,
          peers:          this.engine.swarm.wires.length,
        };

        if (this.ready) {
          info.files = [];

          var self = this;
          this.engine.files.forEach(function(file) {
            info.files.push({ path: file.path, size: file.length, main: (file.path == self.mainFile.path) });
          });

          info.pieces       = this.engine.torrent.pieces.length,
          info.piece_length = this.engine.torrent.pieceLength,
          info.piece_map    = Array(Math.ceil(info.pieces / 100));

          for (var i = 0; i < info.piece_map.length; i++)
            info.piece_map[i] = '';

          for (var i = 0; i < info.pieces; i++)
            info.piece_map[Math.floor(i / 100)] += this.pieceMap[i];

          info.video_ready = this.pieceMap[0] == '*' && this.pieceMap[info.pieces - 1] == '*';
        }

        return info;
      }
    };

    torrent.metadataTimeout = setTimeout(function() {
      console.log('[scrapmagnet] ' + torrent.dn + ': METADATA FAILED');
      trackingEvent('Metadata failed', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
      torrent.destroy();
    }, 30000);

    torrent.engine.on('ready', function() {
      torrent.ready = true;

      // Select main file
      torrent.engine.files.forEach(function(file) {
        if (!torrent.mainFile || torrent.mainFile.length < file.length)
          torrent.mainFile = file;
      });
      torrent.mainFile.select();
      torrent.engine.select(0, Math.min(2, torrent.engine.torrent.pieces.length - 1), true);
      torrent.engine.select(torrent.engine.torrent.pieces.length - 1, torrent.engine.torrent.pieces.length - 1, true);

      // Initialize piece map
      for (var i = 0; i < torrent.engine.torrent.pieces.length; i++)
        if (!torrent.pieceMap[i])
          torrent.pieceMap[i] = '.';

      clearTimeout(torrent.metadataTimeout);
      console.log('[scrapmagnet] ' + torrent.dn + ': METADATA RECEIVED');
      trackingEvent('Metadata received', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
    });

    torrent.engine.on('verify', function(pieceIndex) {
      torrent.pieceMap[pieceIndex] = '*';
    });

    torrent.engine.on('idle', function() {
      if (!torrent.finished && !torrent.paused) {
        torrent.finished = true;
        console.log('[scrapmagnet] ' + torrent.dn + ': FINISHED');
        trackingEvent('Finished', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
      }
    });

    torrent.servingInterval = setInterval(function() {
      if (torrent.engine.swarm.downloaded > (10 * 1024 * 1024)) {
        console.log('[scrapmagnet] ' + torrent.dn + ': SERVING');
        trackingEvent('Serving', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
        clearInterval(torrent.servingInterval);
        torrent.servingInterval = undefined;
      }

    }, 5000);

    console.log('[scrapmagnet] ' + torrent.dn + ': ADDED');
    trackingEvent('Added', { 'Magnet InfoHash': torrent.infoHash, 'Magnet Name': torrent.dn }, torrent.mixpanelData);
    torrents[magnetData.infoHash] = torrent;
  } else {
    torrents[magnetData.infoHash].removeConnection();
  }

  return torrents[magnetData.infoHash];
}

// ----------------------------------------------------------------------------

if (commander.ppid != -1)
setInterval(function() {
  if (!isRunning(commander.ppid))
    shutdown();
});

function shutdown() {
  console.log('[scrapmagnet] Stopping');
  process.exit();
}

var server = app.listen(commander.port, function() {
  console.log('[scrapmagnet] Starting on port %s', commander.port);
  trackingPeopleSet();
});
