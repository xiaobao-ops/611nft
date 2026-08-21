export default class logs {
  constructor() {
  }
  init () {
    this.logData = {}
    this.logs = []
    let e = localStorage.getItem('logs');
    if (e) {
      let t = JSON.parse(e),
        o = Date.now() + 2592e5;
      for (const e in t) {
        let s = t[e];
        for (let e = s.length - 1; e >= 0; e--) {
          let t = s[e];
          if (t.time >= o) {
            console.log(t.time, o), s.splice(0, e);
            break;
          }
        }
      }
      this.logData = Object.assign(this.logData || {}, t)
    }
    let n = localStorage.getItem('actionEvent');
    n && (this.logs = JSON.parse(n));
    console.log('dd')
  }
  getLogs() {
    this.init()
    let e = '';
    (e += '=====Action Event=====\n'),
    this.logs.forEach((t) => {
        'user' == t.type && (e += t.time + `【${t.address}】` + t.event + '\n');
      });
    for (const t in this.logData) {
      let o = this.logData[t];
      (e += '=====' + t + '=====\n'),
        o.forEach((t) => {
          e += t.message + '\n';
        });
    }
    return e;
  }
  exportLogs() {
    var e = document.createElement('a');
    let t = this.getLogs();
    e.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(t)),
      e.setAttribute('download', 'log.txt'),
      (e.style.display = 'none'),
      document.body.appendChild(e),
      e.click(),
      document.body.removeChild(e);
  }
}
