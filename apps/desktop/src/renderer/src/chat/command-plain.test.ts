import { describe, expect, it } from 'vitest';
import { commandFacts, dangerSpans } from './command-plain';

const LONG =
  "Get-ChildItem 'D:\\工作\\样机评审\\报价' -Filter *.xlsx | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Select-Object -First 50 | ForEach-Object { $_.FullName }; Remove-Item 'D:\\工作\\样机评审' -Recurse -Force";

const marked = (command: string) => dangerSpans(command).map(([a, b]) => command.slice(a, b));

describe('what a command will do, from the command itself', () => {
  it('deleting, with everything in it when recursive', () => {
    expect(commandFacts(LONG)).toEqual([{ kind: 'delete', text: '删除 D:\\工作\\样机评审（含其中所有内容）', danger: true }]);
    expect(commandFacts('rm -rf ./build')).toEqual([{ kind: 'delete', text: '删除 ./build（含其中所有内容）', danger: true }]);
    expect(commandFacts('del /s /q C:\\temp\\*.log')).toEqual([{ kind: 'delete', text: '删除 C:\\temp\\*.log（含其中所有内容）', danger: true }]);
    expect(commandFacts('Remove-Item a.txt')).toEqual([{ kind: 'delete', text: '删除 a.txt', danger: true }]);
    expect(commandFacts('cmd /c del a.txt').map((f) => f.text)).toEqual(['删除 a.txt']);
    expect(commandFacts('Get-ChildItem *.tmp | ForEach-Object { Remove-Item $_ }').map((f) => f.kind)).toEqual(['delete']);
  });

  it('moving, copying, overwriting, the network, installing, stopping a program, the registry', () => {
    expect(commandFacts('Move-Item a.txt b.txt').map((f) => f.text)).toEqual(['移动或改名 a.txt']);
    expect(commandFacts('Copy-Item a.txt b.txt -Force').map((f) => [f.text, f.danger])).toEqual([['复制 a.txt', false]]);
    expect(commandFacts('echo hi > notes.txt; echo more >> log.txt').map((f) => [f.text, f.danger])).toEqual([
      ['覆盖 notes.txt', true],
      ['写入 log.txt', false],
    ]);
    expect(commandFacts("Set-Content -Path 'a.txt' -Value x").map((f) => [f.text, f.danger])).toEqual([['覆盖 a.txt', true]]);
    expect(commandFacts('Invoke-WebRequest https://example.com/x.zip -OutFile x.zip').map((f) => f.text)).toEqual(['访问网络 https://example.com/x.zip']);
    expect(commandFacts('npm install left-pad').map((f) => f.text)).toEqual(['安装 left-pad']);
    expect(commandFacts('Stop-Process -Name excel').map((f) => [f.kind, f.danger])).toEqual([['process', true]]);
    expect(commandFacts('reg add HKCU\\Software\\X /v Y /d 1 /f').map((f) => [f.text, f.danger])).toEqual([['修改注册表', true]]);
  });

  it('nothing recognised: nothing said (the card says 运行命令 and shows the command)', () => {
    expect(commandFacts('Get-ChildItem *.xlsx | Measure-Object')).toEqual([]);
    expect(commandFacts('dir 2>$null')).toEqual([]);
    expect(commandFacts('npm run build 2>&1')).toEqual([]);
    expect(commandFacts("python 导出各家报价.py --out './报价'")).toEqual([]);
    // A verb's name inside a path or another word is not the verb.
    expect(commandFacts("Get-ChildItem 'D:\\rm\\del' | Format-Table")).toEqual([]);
    expect(commandFacts('Remove-ItemProperty -Path HKCU:\\X -Name Y').map((f) => f.kind)).toEqual(['registry']);
  });
});

describe('the dangerous words in a command', () => {
  it('the verb and its recursing / forcing flags', () => {
    expect(marked(LONG)).toEqual(['Remove-Item', '-Recurse', '-Force']);
    expect(marked('rm -rf ./build')).toEqual(['rm', '-rf']);
    expect(marked('rd /s /q C:\\temp')).toEqual(['rd', '/s', '/q']);
    expect(marked('Stop-Process -Name excel -Force')).toEqual(['Stop-Process', '-Force']);
  });

  it('a > that overwrites a file, not one that goes to $null or joins the error stream', () => {
    expect(marked('echo hi > notes.txt')).toEqual(['>']);
    expect(marked('echo hi >> notes.txt')).toEqual([]);
    expect(marked('dir 2>$null')).toEqual([]);
    expect(marked('npm run build 2>&1 | Select-String error')).toEqual([]);
    expect(marked('Get-Date -Format yyyy')).toEqual([]);
  });

  it('nothing in a command that changes nothing it cannot take back', () => {
    expect(dangerSpans("python 导出各家报价.py --out './报价'")).toEqual([]);
    expect(dangerSpans('Copy-Item a.txt b.txt -Force')).toEqual([]);
  });
});
