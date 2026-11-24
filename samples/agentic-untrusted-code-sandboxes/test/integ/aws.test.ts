// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { execFile } from 'node:child_process';
import { Aws, redact } from './aws';
import { unavailableReason } from './leftovers';

jest.mock('node:child_process', () => ({ execFile: jest.fn() }));

type Callback = (error: Error | null, stdout?: string, stderr?: string) => void;

/** The shape `execFile` gives a failed process: an error with the process's `stderr` and exit `code`. */
const failWith = (stderr: string, code: number | string): void => {
  (execFile as unknown as jest.Mock).mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Callback) => {
    cb(Object.assign(new Error(`Command failed: aws sts get-caller-identity\n${stderr}`), { stderr, code }));
  });
};

const failure = async (args: string[]): Promise<Error & { stderr?: string }> => {
  const e = await new Aws('eu-west-1').cli(args).then(() => undefined, (err: unknown) => err);
  return e as Error & { stderr?: string };
};

describe('aws.cli', () => {
  test('keeps the CLI stderr on the error, and names the service and operation but not the arguments', async () => {
    failWith('Unable to locate credentials.', 255);
    const e = await failure(['route53resolver', 'get-firewall-rule-group', '--firewall-rule-group-id', 'rslvr-frg-1']);
    expect(e.stderr).toBe('Unable to locate credentials.');
    expect(e.message).toBe('aws route53resolver get-firewall-rule-group failed: Unable to locate credentials.');
    expect(unavailableReason(e)).toBe('no credentials found');
  });

  test.each([['ENOENT'], ['EACCES']])('an aws binary that cannot start (%s) is a check that could not run', async (code) => {
    (execFile as unknown as jest.Mock).mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Callback) => {
      // The shape a promisified execFile gives a process that never started: an empty stderr and stdout.
      cb(Object.assign(new Error(`spawn aws ${code}`), { code, stdout: '', stderr: '' }));
    });
    const e = await failure(['sts', 'get-caller-identity']);
    expect(unavailableReason(e)).toBe('the aws CLI could not be started');
  });

  test('replaces ARNs and account ids in the cause', async () => {
    const id = '1'.repeat(12);
    const key = `AKIA${'B'.repeat(16)}`;
    failWith(`An error occurred (AccessDeniedException): User: arn:aws:sts::${id}:assumed-role/Role/session is not authorized; account ${id}; key ${key}`, 254);
    const e = await failure(['service-quotas', 'get-service-quota']);
    expect(e.message).toBe('aws service-quotas get-service-quota failed: An error occurred (AccessDeniedException): User: <arn> is not authorized; account <account>; key <key>');
    expect(e.stderr).not.toContain(id);
    expect(e.stderr).not.toContain(key);
    expect(unavailableReason(e)).toBe('access denied');
  });

  test('a process stopped by a signal, with no stderr, is described without its command line', async () => {
    (execFile as unknown as jest.Mock).mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Callback) => {
      cb(Object.assign(new Error('Command failed: aws route53resolver get-firewall-rule-group --firewall-rule-group-id rslvr-frg-1'), { code: null, signal: 'SIGKILL', stderr: '' }));
    });
    const e = await failure(['route53resolver', 'get-firewall-rule-group', '--firewall-rule-group-id', 'rslvr-frg-1']);
    expect(e.message).toBe('aws route53resolver get-firewall-rule-group failed: the aws CLI exited with signal SIGKILL');
  });

  test.each([
    ['an exit code', { code: 255, stderr: '' }, 'the aws CLI exited with code 255'],
    ['a whitespace-only stderr', { code: 255, stderr: ' \n' }, 'the aws CLI exited with code 255'],
    ['a buffer limit', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stderr: '' }, 'the aws CLI failed (ERR_CHILD_PROCESS_STDIO_MAXBUFFER)'],
    ['no code and no signal', { stderr: '' }, 'the aws CLI failed (no exit code)'],
  ])('a process with no stderr and %s is described by that', async (_shape, props, text) => {
    (execFile as unknown as jest.Mock).mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Callback) => {
      cb(Object.assign(new Error('Command failed: aws sts get-caller-identity --secret-arg'), props));
    });
    const e = await failure(['sts', 'get-caller-identity']);
    expect(e.message).toBe(`aws sts get-caller-identity failed: ${text}`);
  });

  test('the cause is read from the whole stderr, and the message carries its first 2000 characters', async () => {
    failWith(`${'Traceback line\n'.repeat(200)}An error occurred (ExpiredToken) when calling the GetServiceQuota operation`, 255);
    const e = await failure(['service-quotas', 'get-service-quota']);
    expect(e.message.length).toBe('aws service-quotas get-service-quota failed: '.length + 2000);
    expect(e.message).not.toContain('ExpiredToken');
    expect(unavailableReason(e)).toBe('the credentials expired');
  });
});

describe('redact', () => {
  const id = '1'.repeat(12);
  test.each([
    ['an ASIA access key id', `key ASIA${'C'.repeat(16)} used`, 'key <key> used'],
    ['an aws-cn ARN', `on arn:aws-cn:iam::${id}:role/R.`, 'on <arn>'],
    ['a session token', `token IQoJ${'b'.repeat(120)}== sent`, 'token <token> sent'],
    ['an older FQoG session token', `token FQoG${'b'.repeat(120)} sent`, 'token <token> sent'],
    ['a long base64 run with no known prefix', `token ${'b'.repeat(120)} sent`, 'token <token> sent'],
    ['an older AQoD session token', `token AQoD${'b'.repeat(120)} sent`, 'token <token> sent'],
    ['a SigV2 presigned signature', 'https://h/?AWSAccessKeyId=x&Signature=abc%2Bdef&Expires=1', 'https://h/?AWSAccessKeyId=x&Signature=<redacted>&Expires=1'],
    ['a secret key followed by =', `secret=${'A'.repeat(20)}/${'b'.repeat(19)}=`, 'secret=<secret>='],
    ['the X-Amz query values of a presigned URL', 'https://h/?X-Amz-Security-Token=abc%2F&X-Amz-Signature=def', 'https://h/?X-Amz-Security-Token=<redacted>&X-Amz-Signature=<redacted>'],
    ['a secret key', `secret ${'A'.repeat(20)}/${'b'.repeat(19)} end`, 'secret <secret> end'],
    ['an account id glued to a word', `Role_${id}x`, 'Role_<account>x'],
    ['a SigV4 signature in an Authorization header', `Authorization: AWS4-HMAC-SHA256 Credential=x/s, SignedHeaders=host, Signature=${'f'.repeat(64)}`, 'Authorization: AWS4-HMAC-SHA256 Credential=x/s, SignedHeaders=host, Signature=<redacted>'],
    ['a lower-case signature query value', 'https://h/?signature=abc', 'https://h/?signature=<redacted>'],
    ['a base64url token', `token ${'a-b_'.repeat(30)} sent`, 'token <token> sent'],
    ['a JWT with short parts', `token eyJhbGciOiJSUzI1NiJ9.${'p'.repeat(60)}.${'s'.repeat(60)} sent`, 'token <token> sent'],
    ['a JWT under 100 characters', `token eyJ${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)} sent`, 'token <token> sent'],
    ['a lower-case x-amz query value', 'https://h/?x-amz-security-token=abc', 'https://h/?x-amz-security-token=<redacted>'],
    ['a short FwoG session token', `token FwoG${'b'.repeat(60)} sent`, 'token <token> sent'],
    ['a long base64 run ending in =', `token ${'b'.repeat(120)}== sent`, 'token <token> sent'],
    ['a key id inside a longer capital run', `XAKIA${'B'.repeat(16)}`, 'X<key>'],
  ])('replaces %s', (_shape, text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  test('leaves a 13-digit number alone', () => {
    expect(redact(`${id}3`)).toBe(`${id}3`);
  });

  test.each([
    ['a 41-character run', 'A'.repeat(41)],
    ['a key id followed by more capitals', `AKIA${'B'.repeat(17)}`],
    ['a 40-character run inside a path', `/${'a'.repeat(40)}`],
  ])('leaves %s alone', (_shape, text) => {
    expect(redact(text)).toBe(text);
  });

  test.each(['FQoG', 'AQoD'])('replaces a session token that starts with %s', (prefix) => {
    expect(redact(`t ${prefix}${'z'.repeat(80)} x`)).toBe('t <token> x');
  });

  test.each([
    ['only dots', '.'.repeat(1024 * 1024)],
    ['a dotted mix', 'ab.cd+ef/gh_ij-kl.'.repeat(60_000)],
    ['JWT prefixes', 'eyJ'.repeat(350_000)],
    ['short JWT-like runs', 'eyJabcdefgh.x '.repeat(80_000)],
  ])('a long input of %s is redacted in under a second', (_shape, text) => {
    const t0 = Date.now();
    redact(text);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('a long input that repeats an X-Amz name without a value is handled in linear time', () => {
    const text = 'x-amz-'.repeat(50_000);
    const t0 = Date.now();
    expect(redact(text)).toBe('<token>');
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('a long stderr', () => {
  test.each([
    ['an X-Amz name with no value', 'X-Amz-a'],
    ['a token name with no end', 'Token for '],
    ['an SSO session with no end', 'SSO session '],
    ['a config profile with no end', 'config profile '],
  ])('of 1 MB that repeats %s is redacted and classified in under a second', async (_shape, piece) => {
    failWith(piece.repeat(Math.ceil((1024 * 1024) / piece.length)), 255);
    const t0 = Date.now();
    const e = await failure(['sts', 'get-caller-identity']);
    unavailableReason(e);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test.each([['Token for '], ['SSO session '], ['config profile ']])(
    'of 256 KB that repeats %s is classified in under a second, without the cut', (piece) => {
      const e = Object.assign(new Error('aws sts get-caller-identity failed'), { stderr: piece.repeat(Math.ceil((256 * 1024) / piece.length)) });
      const t0 = Date.now();
      unavailableReason(e);
      expect(Date.now() - t0).toBeLessThan(1000);
    });

  test('keeps only its first and last 64 KB', async () => {
    failWith('x '.repeat(512 * 1024), 255);
    expect((await failure(['sts', 'get-caller-identity'])).stderr?.length).toBeLessThanOrEqual(2 * 64 * 1024 + 5);
  });

  test('does not split a secret at the cut', async () => {
    const secret = `${'A'.repeat(20)}/${'b'.repeat(19)}`;
    failWith(`${'x '.repeat(32_758)}${secret} ${'y '.repeat(40_000)}`, 255);
    const { stderr } = await failure(['sts', 'get-caller-identity']);
    expect(stderr).not.toContain('A'.repeat(20));
    expect(stderr).not.toContain('b'.repeat(19));
  });

  test('keeps the cause at its end when the middle is cut', async () => {
    failWith(`${'warning line\n'.repeat(20_000)}An error occurred (ExpiredToken) when calling the GetServiceQuota operation`, 255);
    expect(unavailableReason(await failure(['service-quotas', 'get-service-quota']))).toBe('the credentials expired');
  });

  test('is trimmed', async () => {
    failWith('  Unable to locate credentials.\n', 255);
    expect((await failure(['sts', 'get-caller-identity'])).stderr).toBe('Unable to locate credentials.');
  });
});
