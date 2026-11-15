(function (R) {
  'use strict';

  var STRAVA_UPLOAD_URL = 'https://www.strava.com/upload/select';
  var TZ = 'America/Santiago';

  // ---------- Utilidades ----------

  function escXml(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : null; }

  function lookupWorkout(id, workouts) {
    if (id == null) return null;
    try {
      if (typeof workouts === 'function') return workouts(id) || null;
      if (workouts && workouts[id]) return workouts[id];
      var T = R.training;
      if (T) {
        if (typeof T.getWorkout === 'function') return T.getWorkout(id) || null;
        var lib = T.workouts || T.WORKOUTS || T.library;
        if (Array.isArray(lib)) return lib.find(function (w) { return w.id === id; }) || null;
        if (lib && lib[id]) return lib[id];
      }
    } catch (e) { /* sin biblioteca de workouts */ }
    return null;
  }

  // ---------- Strava / TCX ----------

  function stravaActivityName(activity) {
    var a = activity || {};
    var base = a.name || (a.type === 'route' ? 'Ruta' : a.type === 'workout' ? 'Entrenamiento' : 'Rodada libre');
    return '🚴 Rodillator · ' + base;
  }

  function positionAt(activity, distM) {
    try {
      if (!(R.routes && R.routes.sampleAt) || !activity.routeId || !R.routes.get) return null;
      var route = R.routes.get(activity.routeId);
      if (!route) return null;
      var p = R.routes.sampleAt(route, distM);
      if (!p) return null;
      var lat = Array.isArray(p) ? p[0] : p.lat;
      var lon = Array.isArray(p) ? p[1] : (p.lon != null ? p.lon : p.lng);
      if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return null;
      return { lat: lat, lon: lon };
    } catch (e) { return null; }
  }

  function toTCX(activity, profile) {
    var a = activity || {};
    var startMs = Date.parse(a.date);
    if (isNaN(startMs)) startMs = 0;
    var startIso = new Date(startMs).toISOString();
    var samples = Array.isArray(a.samples) ? a.samples : [];
    var tps = samples.map(function (s) {
      var t = s[0], w = s[1], hr = s[2], cad = s[3], spd = s[4], dist = s[5], ele = s[6];
      var x = '<Trackpoint><Time>' + new Date(startMs + (t || 0) * 1000).toISOString() + '</Time>';
      var pos = positionAt(a, dist || 0);
      if (pos) x += '<Position><LatitudeDegrees>' + pos.lat.toFixed(6) + '</LatitudeDegrees><LongitudeDegrees>' + pos.lon.toFixed(6) + '</LongitudeDegrees></Position>';
      if (num(ele, 1) !== null) x += '<AltitudeMeters>' + num(ele, 1) + '</AltitudeMeters>';
      x += '<DistanceMeters>' + (num(dist, 1) || '0.0') + '</DistanceMeters>';
      if (typeof hr === 'number' && hr > 0) x += '<HeartRateBpm><Value>' + Math.round(hr) + '</Value></HeartRateBpm>';
      if (typeof cad === 'number' && cad >= 0) x += '<Cadence>' + Math.min(254, Math.round(cad)) + '</Cadence>';
      x += '<Extensions><ns3:TPX>';
      if (num(spd, 3) !== null) x += '<ns3:Speed>' + num(spd, 3) + '</ns3:Speed>';
      x += '<ns3:Watts>' + Math.max(0, Math.round(w || 0)) + '</ns3:Watts></ns3:TPX></Extensions></Trackpoint>';
      return x;
    });
    var lap = '<Lap StartTime="' + startIso + '">' +
      '<TotalTimeSeconds>' + (num(a.durationS, 1) || '0.0') + '</TotalTimeSeconds>' +
      '<DistanceMeters>' + (num(a.distanceM, 1) || '0.0') + '</DistanceMeters>' +
      '<Calories>' + Math.max(0, Math.round(a.kcal || 0)) + '</Calories>';
    if (typeof a.avgHr === 'number' && a.avgHr > 0) lap += '<AverageHeartRateBpm><Value>' + Math.round(a.avgHr) + '</Value></AverageHeartRateBpm>';
    lap += '<Intensity>Active</Intensity>';
    if (typeof a.avgCadence === 'number' && a.avgCadence >= 0) lap += '<Cadence>' + Math.min(254, Math.round(a.avgCadence)) + '</Cadence>';
    lap += '<TriggerMethod>Manual</TriggerMethod><Track>' + tps.join('') + '</Track></Lap>';
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" ' +
      'xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd">' +
      '<Activities><Activity Sport="Biking"><Id>' + startIso + '</Id>' + lap +
      '<Notes>' + escXml(stravaActivityName(a)) + '</Notes>' +
      '</Activity></Activities></TrainingCenterDatabase>\n';
  }

  // ---------- iCalendar ----------

  function escIcs(s) {
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  // Pliega a 75 octetos UTF-8 por línea sin partir caracteres.
  function foldLine(line) {
    var enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;
    var out = [], cur = '', curBytes = 0, limit = 75;
    for (var ch of line) {
      var b = enc.encode(ch).length;
      if (curBytes + b > limit) { out.push(cur); cur = ' '; curBytes = 1; limit = 75; }
      cur += ch; curBytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function todayInSantiago(now) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    } catch (e) {
      return now.toISOString().slice(0, 10);
    }
  }

  var MOTIVATION = [
    'La constancia gana: cada sesión suma.',
    'Hoy pedaleas por tu objetivo.',
    'Calienta bien, respira y disfruta.',
    'Un pedalazo a la vez.'
  ];

  var VTIMEZONE = [
    'BEGIN:VTIMEZONE',
    'TZID:' + TZ,
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:-0400',
    'TZOFFSETTO:-0300',
    'TZNAME:-03',
    'DTSTART:19700906T000000',
    'RRULE:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=2,3,4,5,6,7,8;BYDAY=SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:-0300',
    'TZOFFSETTO:-0400',
    'TZNAME:-04',
    'DTSTART:19700405T000000',
    'RRULE:FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=2,3,4,5,6,7,8;BYDAY=SU',
    'END:STANDARD',
    'END:VTIMEZONE'
  ];

  // opts: { plan, settings, profile, now?: Date, workouts?: fn(id)|map }
  function toICS(opts) {
    opts = opts || {};
    var settings = opts.settings || {};
    var now = opts.now instanceof Date ? opts.now : new Date();
    var today = todayInSantiago(now);
    var time = /^\d{1,2}:\d{2}$/.test(settings.reminderTime || '') ? settings.reminderTime : '19:00';
    var hh = parseInt(time.split(':')[0], 10), mm = parseInt(time.split(':')[1], 10);
    var stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    var lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rodillator//Plan de entrenamiento//ES', 'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH', 'X-WR-CALNAME:Rodillator', 'X-WR-TIMEZONE:' + TZ
    ].concat(VTIMEZONE);
    var n = 0;
    var weeks = (opts.plan && Array.isArray(opts.plan.weeks)) ? opts.plan.weeks : [];
    weeks.forEach(function (wk) {
      (wk.days || []).forEach(function (day) {
        if (!day || !day.workoutId || day.status === 'hecho' || day.status === 'saltado') return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || day.date < today) return;
        var w = lookupWorkout(day.workoutId, opts.workouts);
        var name = (w && w.name) || String(day.workoutId);
        var durS = (w && w.durationS) || 3600;
        var y = +day.date.slice(0, 4), mo = +day.date.slice(5, 7), d = +day.date.slice(8, 10);
        var startUtc = Date.UTC(y, mo - 1, d, hh, mm);
        var end = new Date(startUtc + durS * 1000);
        var fmtLocal = function (dt) {
          return dt.getUTCFullYear() + pad(dt.getUTCMonth() + 1) + pad(dt.getUTCDate()) + 'T' + pad(dt.getUTCHours()) + pad(dt.getUTCMinutes()) + '00';
        };
        var desc = [];
        var bits = ['Duración: ' + Math.round(durS / 60) + ' min'];
        if (w && w.tss != null) bits.push('TSS: ' + Math.round(w.tss));
        desc.push(bits.join(' · '));
        if (w && w.description) desc.push(w.description);
        desc.push(MOTIVATION[n % MOTIVATION.length]);
        lines.push(
          'BEGIN:VEVENT',
          'UID:rodillator-' + day.date + '-' + escIcs(day.workoutId) + '@rodillator.app',
          'DTSTAMP:' + stamp,
          'DTSTART;TZID=' + TZ + ':' + fmtLocal(new Date(startUtc)),
          'DTEND;TZID=' + TZ + ':' + fmtLocal(end),
          'SUMMARY:' + escIcs(name),
          'DESCRIPTION:' + escIcs(desc.join('\n')),
          'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:' + escIcs('Rodillator: ' + name), 'END:VALARM',
          'END:VEVENT'
        );
        n++;
      });
    });
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  // ---------- Recordatorios ----------

  function requestNotificationPermission() {
    try {
      if (typeof Notification === 'undefined') return Promise.resolve('unsupported');
      if (Notification.permission === 'granted' || Notification.permission === 'denied') return Promise.resolve(Notification.permission);
      return Promise.resolve(Notification.requestPermission()).then(function (p) {
        return p === 'granted' ? 'granted' : 'denied';
      }, function () { return 'denied'; });
    } catch (e) { return Promise.resolve('unsupported'); }
  }

  // Dispara si hoy es día de recordatorio, ya pasó la hora (ventana de 60 min) y no se disparó hoy.
  function createReminderScheduler(opts) {
    opts = opts || {};
    var getState = opts.getState || function () { return {}; };
    var onFire = opts.onFire || function () {};
    var nowFn = opts.now || function () { return new Date(); };
    var setIv = opts.setInterval || function (f, ms) { return setInterval(f, ms); };
    var clearIv = opts.clearInterval || function (h) { clearInterval(h); };
    var handle = null, lastFired = null;

    function check() {
      try {
        var st = getState() || {};
        var s = st.settings || {};
        var now = nowFn();
        var key = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
        if (lastFired === key) return false;
        if (!Array.isArray(s.reminderDays) || s.reminderDays.indexOf(now.getDay()) < 0) return false;
        var m = /^(\d{1,2}):(\d{2})$/.exec(s.reminderTime || '');
        if (!m) return false;
        var diff = now.getHours() * 60 + now.getMinutes() - (parseInt(m[1], 10) * 60 + parseInt(m[2], 10));
        if (diff < 0 || diff >= 60) return false;
        lastFired = key;
        var body = 'Es hora de tu entrenamiento en el rodillo.';
        var weeks = (st.plan && st.plan.weeks) || [];
        weeks.forEach(function (wk) {
          (wk.days || []).forEach(function (d) {
            if (d.date === key && d.workoutId && d.status === 'pendiente') {
              var w = lookupWorkout(d.workoutId, opts.workouts);
              body = 'Hoy toca: ' + ((w && w.name) || d.workoutId) + '.';
            }
          });
        });
        var payload = { title: '🚴 Rodillator', body: body };
        try { onFire(payload); } catch (e) { /* UI */ }
        try {
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(payload.title, { body: payload.body });
        } catch (e) { /* notificaciones no disponibles en el iframe */ }
        return true;
      } catch (e) { return false; }
    }

    return {
      start: function () { if (handle === null) { handle = setIv(check, 60000); check(); } },
      stop: function () { if (handle !== null) { clearIv(handle); handle = null; } },
      _check: check
    };
  }

  // ---------- Guardado de archivos ----------

  async function saveFile(file) {
    var f = file || {};
    try {
      var c = globalThis.claude;
      if (c && typeof c.use === 'function') {
        var dl = await c.use('downloads');
        if (dl && typeof dl.save === 'function') {
          await dl.save({ filename: f.filename, data: f.data });
          return { ok: true };
        }
      }
    } catch (e) {
      return { ok: false, fallback: 'copy', data: f.data, rejected: true };
    }
    return { ok: false, fallback: 'copy', data: f.data };
  }

  R.integrations = {
    toTCX: toTCX,
    stravaUploadUrl: STRAVA_UPLOAD_URL,
    stravaActivityName: stravaActivityName,
    toICS: toICS,
    createReminderScheduler: createReminderScheduler,
    requestNotificationPermission: requestNotificationPermission,
    saveFile: saveFile,
    _foldLine: foldLine
  };
})(typeof window !== 'undefined' ? (window.R = window.R || {}) : (globalThis.R = globalThis.R || {}));
