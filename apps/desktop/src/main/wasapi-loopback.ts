import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { WebContents } from 'electron';
import type {
  WasapiAudioChunkPayload,
  WasapiEndpointProbeResult,
} from '../shared/bridge';

export class WasapiLoopbackManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly binaryPath: string;

  constructor(binaryPath?: string) {
    this.binaryPath =
      binaryPath || path.join(__dirname, '../native/wasapi-loopback.exe');
  }

  public async probeEndpoint(): Promise<WasapiEndpointProbeResult> {
    return new Promise((resolve) => {
      const child = spawn(this.binaryPath, ['--probe'], {
        windowsHide: true,
      });

      let stdoutData = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutData += chunk.toString('utf8');
      });

      child.on('error', (err) => {
        resolve({
          ok: false,
          endpointId: '',
          sampleRate: 0,
          channels: 0,
          bitsPerSample: 0,
          error: err.message,
        });
      });

      child.on('close', () => {
        const line = stdoutData.trim().split(/\r?\n/)[0] || '';
        try {
          const parsed = JSON.parse(line) as {
            ok?: boolean;
            endpointId?: string;
            sampleRate?: number;
            channels?: number;
            bitsPerSample?: number;
            stage?: string;
            hresult?: number;
          };
          if (parsed.ok) {
            resolve({
              ok: true,
              endpointId: parsed.endpointId || 'default-render',
              sampleRate: parsed.sampleRate || 48000,
              channels: parsed.channels || 2,
              bitsPerSample: parsed.bitsPerSample || 32,
            });
          } else {
            resolve({
              ok: false,
              endpointId: '',
              sampleRate: 0,
              channels: 0,
              bitsPerSample: 0,
              error: `Stage=${parsed.stage ?? 'unknown'} HRESULT=${parsed.hresult ?? -1}`,
            });
          }
        } catch (err) {
          resolve({
            ok: false,
            endpointId: '',
            sampleRate: 0,
            channels: 0,
            bitsPerSample: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    });
  }

  public async startCapture(
    targetWebContents: WebContents,
    options: { playTestTone: boolean }
  ): Promise<WasapiEndpointProbeResult> {
    this.stopCapture();

    const args: string[] = [];
    if (options.playTestTone) {
      args.push('--play-test-tone');
    }

    return new Promise((resolve) => {
      let resolved = false;
      const child = spawn(this.binaryPath, args, {
        windowsHide: true,
      });
      this.proc = child;

      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const msg = JSON.parse(trimmed) as {
            type: string;
            endpointId?: string;
            sampleRate?: number;
            channels?: number;
            bitsPerSample?: number;
            frames?: number;
            rms?: number;
            peak?: number;
            pcmFloat32Base64?: string;
            stage?: string;
            hresult?: number;
            message?: string;
          };

          if (msg.type === 'started') {
            if (!resolved) {
              resolved = true;
              resolve({
                ok: true,
                endpointId: msg.endpointId || 'default-render',
                sampleRate: msg.sampleRate || 48000,
                channels: msg.channels || 2,
                bitsPerSample: msg.bitsPerSample || 32,
              });
            }
          } else if (
            msg.type === 'chunk' &&
            msg.pcmFloat32Base64 &&
            !targetWebContents.isDestroyed()
          ) {
            const payload: WasapiAudioChunkPayload = {
              sampleRate: msg.sampleRate || 48000,
              frames: msg.frames || 960,
              rms: msg.rms ?? 0,
              peak: msg.peak ?? 0,
              pcmFloat32Base64: msg.pcmFloat32Base64,
            };
            targetWebContents.send('elm:wasapi-loopback-chunk', payload);
          } else if (msg.type === 'error' && !resolved) {
            resolved = true;
            resolve({
              ok: false,
              endpointId: '',
              sampleRate: 0,
              channels: 0,
              bitsPerSample: 0,
              error:
                msg.message ||
                `Stage=${msg.stage ?? 'unknown'} HRESULT=${msg.hresult ?? -1}`,
            });
          }
        } catch {
          // Ignore malformed stdout lines
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          resolve({
            ok: false,
            endpointId: '',
            sampleRate: 0,
            channels: 0,
            bitsPerSample: 0,
            error: err.message,
          });
        }
      });

      child.on('close', () => {
        if (this.proc === child) {
          this.proc = null;
        }
        if (!resolved) {
          resolved = true;
          resolve({
            ok: false,
            endpointId: '',
            sampleRate: 0,
            channels: 0,
            bitsPerSample: 0,
            error: 'WASAPI helper process exited before starting.',
          });
        }
      });
    });
  }

  public stopCapture(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // Ignore kill error
      }
      this.proc = null;
    }
  }
}
