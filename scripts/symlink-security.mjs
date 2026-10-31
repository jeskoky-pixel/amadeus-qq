import {spawnSync} from 'node:child_process';
if(process.platform!=='linux')throw Error('Run this release gate on Linux; Windows skips do not satisfy it');
const files=['tests/audio-read.test.mjs','tests/media-read.test.mjs','tests/file-read.test.mjs','tests/outbound-media.test.mjs'];
const result=spawnSync(process.execPath,['--test','--test-name-pattern=symlink',...files],{encoding:'utf8'});
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
const cases=(result.stdout??'').split(/\r?\n/).filter(line=>/^(?:not )?ok \d+ - .*symlink/i.test(line));
if(result.status!==0||cases.length!==4||cases.some(line=>!line.startsWith('ok ')||/# SKIP|# TODO/.test(line)))throw Error('All four symlink security cases must execute and pass without skips');
console.log('RELEASE_GATE: 4 symlink safety tests executed and passed');
