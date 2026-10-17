'use strict';
/*
 * Shared CLI plumbing for the Phase 0 tools: connection options and credential prompts.
 * Credentials are prompted for on the terminal (password hidden) and never written
 * anywhere. --user skips the username prompt.
 */

const readline = require('node:readline');

const CONN_OPTIONS = {
    host: {type: 'string', short: 'H'},
    port: {type: 'string', short: 'p', default: '80'},
    user: {type: 'string', short: 'u'},
    profile: {type: 'string'},
    timeout: {type: 'string', default: '10000'},
    help: {type: 'boolean', short: 'h'}
};

// One line iterator for the life of the process: a readline interface per question would
// swallow the following lines when stdin is a pipe.
let lines = null;

async function ask(question) {
    if (process.stdin.isTTY) {
        // A one-shot interface, closed before askHidden takes over stdin in raw mode.
        const rl = readline.createInterface({input: process.stdin, output: process.stderr});
        return new Promise((resolve) =>
            rl.question(question, (a) => {
                rl.close();
                resolve(a.trim());
            })
        );
    }
    process.stderr.write(question);
    if (!lines) lines = readline.createInterface({input: process.stdin, terminal: false})[Symbol.asyncIterator]();
    const {value, done} = await lines.next();
    if (done) throw new Error('no input');
    return value.trim();
}

/** Read a line without echo when stdin is a TTY. */
function askHidden(question) {
    if (!process.stdin.isTTY) return ask(question);
    return new Promise((resolve, reject) => {
        process.stderr.write(question);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        let buf = '';
        const onData = (s) => {
            for (const ch of s) {
                if (ch === '\r' || ch === '\n' || ch === '\u0004') {
                    done();
                    resolve(buf);
                    return;
                }
                if (ch === '\u0003') {
                    done();
                    reject(new Error('cancelled'));
                    return;
                }
                if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
                else buf += ch;
            }
        };
        function done() {
            stdin.removeListener('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stderr.write('\n');
        }
        stdin.on('data', onData);
    });
}

/** Build a CameraConn from parsed values, prompting for credentials. */
async function connFromArgs(values) {
    if (!values.host) throw new Error('--host is required');
    const username = values.user !== undefined ? values.user : await ask(`ONVIF username for ${values.host}: `);
    const password = await askHidden(`ONVIF password for ${username}@${values.host}: `);
    return {
        hostname: values.host,
        port: Number(values.port),
        username,
        password,
        profileToken: values.profile,
        timeoutMs: Number(values.timeout)
    };
}

const CONN_HELP = `Connection:
  -H, --host <ip>        camera address (required)
  -p, --port <n>         ONVIF device service port (default 80)
  -u, --user <name>      username (prompted if omitted); password is always prompted
      --profile <token>  media profile (default: first with a PTZ configuration)
      --timeout <ms>     per request timeout (default 10000)`;

module.exports = {CONN_OPTIONS, CONN_HELP, connFromArgs, ask, askHidden};
