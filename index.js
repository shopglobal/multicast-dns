var packet = require('dns-packet')
var dgram = require('dgram')
var thunky = require('thunky')
var events = require('events')
var os = require('os')

var noop = function () {}

module.exports = function (opts) {
  if (!opts) opts = {}

  var that = new events.EventEmitter()
  var port = typeof opts.port === 'number' ? opts.port : 5353
  var type = opts.type || 'udp4'
  var ip = opts.ip || opts.host || (type === 'udp4' ? '224.0.0.251' : null)
  var me = {address: ip, port: port}
  var destroyed = false

  var localInterfaces = (function () {
    var osInterfaces = os.networkInterfaces()
    var localAddresses = {
      v4: [],
      v6: []
    }
    for (var osInterface in osInterfaces) {
      var osAddresses = osInterfaces[osInterface]
      for (var i = 0; i < osAddresses.length; i++) {
        var osAddress = osAddresses[i]
        if (osAddress.internal) continue
        if (osAddress.family === 'IPv4') localAddresses.v4.push(osAddress.address)
        if (osAddress.family === 'IPv6') localAddresses.v6.push(osAddress.address)
      }
    }
    return localAddresses
  })()

  if (!opts.interface) {
    if (type === 'udp4') opts.interface = localInterfaces.v4
    if (type === 'udp6') opts.interface = localInterfaces.v6
  } else {
    opts.interface = [ opts.interface ]
  }

  if (type === 'udp6' && (!ip || !opts.interface)) {
    throw new Error('For IPv6 multicast you must specify `ip` and `interface`')
  }

  var socket = opts.socket || dgram.createSocket({
    type: type,
    reuseAddr: opts.reuseAddr !== false,
    toString: function () {
      return type
    }
  })

  socket.on('error', function (err) {
    if (err.code === 'EACCES' || err.code === 'EADDRINUSE') that.emit('error', err)
    else that.emit('warning', err)
  })

  socket.on('message', function (message, rinfo) {
    try {
      message = packet.decode(message)
    } catch (err) {
      that.emit('warning', err)
      return
    }

    that.emit('packet', message, rinfo)

    if (message.type === 'query') that.emit('query', message, rinfo)
    if (message.type === 'response') that.emit('response', message, rinfo)
  })

  socket.on('listening', function () {
    if (!port) port = me.port = socket.address().port
    if (opts.multicast !== false) {
      for (var i = 0; i < opts.interface.length; i++) {
        socket.addMembership(ip, opts.interface[i])
      }
      socket.setMulticastTTL(opts.ttl || 255)
      socket.setMulticastLoopback(opts.loopback !== false)
    }
  })

  var bind = thunky(function (cb) {
    if (!port) return cb(null)
    socket.once('error', cb)
    if (opts.interface.length === 1) {
      socket.bind({port: port, address: opts.interface[0]}, function () {
        socket.removeListener('error', cb)
        cb(null)
      })
    } else {
      socket.bind({port: port}, function () {
        socket.removeListener('error', cb)
        cb(null)
      })
    }
  })

  bind(function (err) {
    if (err) return that.emit('error', err)
    that.emit('ready')
  })

  that.send = function (value, rinfo, cb) {
    if (typeof rinfo === 'function') return that.send(value, null, rinfo)
    if (!cb) cb = noop
    if (!rinfo) rinfo = me
    bind(function (err) {
      if (destroyed) return cb()
      if (err) return cb(err)
      var message = packet.encode(value)
      socket.send(message, 0, message.length, rinfo.port, rinfo.address || rinfo.host, cb)
    })
  }

  that.response =
  that.respond = function (res, rinfo, cb) {
    if (Array.isArray(res)) res = {answers: res}

    res.type = 'response'
    that.send(res, rinfo, cb)
  }

  that.query = function (q, type, rinfo, cb) {
    if (typeof type === 'function') return that.query(q, null, null, type)
    if (typeof type === 'object' && type && type.port) return that.query(q, null, type, rinfo)
    if (typeof rinfo === 'function') return that.query(q, type, null, rinfo)
    if (!cb) cb = noop

    if (typeof q === 'string') q = [{name: q, type: type || 'ANY'}]
    if (Array.isArray(q)) q = {type: 'query', questions: q}

    q.type = 'query'
    that.send(q, rinfo, cb)
  }

  that.destroy = function (cb) {
    if (!cb) cb = noop
    if (destroyed) return process.nextTick(cb)
    destroyed = true
    socket.once('close', cb)
    socket.close()
  }

  return that
}
