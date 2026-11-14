using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace ElmAnyDesk.Native
{
    internal enum EDataFlow
    {
        eRender = 0,
        eCapture = 1,
        eAll = 2
    }

    internal enum ERole
    {
        eConsole = 0,
        eMultimedia = 1,
        eCommunications = 2
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject
    {
    }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(EDataFlow dataFlow, uint dwStateMask, out IntPtr ppDevices);

        [PreserveSig]
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppEndpoint);

        [PreserveSig]
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);

        [PreserveSig]
        int RegisterEndpointNotificationCallback(IntPtr pClient);

        [PreserveSig]
        int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);

        [PreserveSig]
        int OpenPropertyStore(uint stgmAccess, out IntPtr ppProperties);

        [PreserveSig]
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);

        [PreserveSig]
        int GetState(out uint pdwState);
    }

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient
    {
        [PreserveSig]
        int Initialize(int ShareMode, uint StreamFlags, long hnsBufferDuration, long hnsPeriodicity, IntPtr pFormat, IntPtr AudioSessionGuid);

        [PreserveSig]
        int GetBufferSize(out uint pNumBufferFrames);

        [PreserveSig]
        int GetStreamLatency(out long phnsLatency);

        [PreserveSig]
        int GetCurrentPadding(out uint pNumPaddingFrames);

        [PreserveSig]
        int IsFormatSupported(int ShareMode, IntPtr pFormat, out IntPtr ppClosestMatch);

        [PreserveSig]
        int GetMixFormat(out IntPtr ppDeviceFormat);

        [PreserveSig]
        int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);

        [PreserveSig]
        int Start();

        [PreserveSig]
        int Stop();

        [PreserveSig]
        int Reset();

        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);

        [PreserveSig]
        int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);

        [PreserveSig]
        int ReleaseBuffer(uint NumFramesRead);

        [PreserveSig]
        int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    [ComImport]
    [Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioRenderClient
    {
        [PreserveSig]
        int GetBuffer(uint NumFramesRequested, out IntPtr ppData);

        [PreserveSig]
        int ReleaseBuffer(uint NumFramesWritten, uint dwFlags);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    internal struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    internal static class Program
    {
        private const int AUDCLNT_SHAREMODE_SHARED = 0;
        private const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        private const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        private const uint CLSCTX_ALL = 23;

        private static Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        private static Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        private static Guid IID_IAudioRenderClient = new Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2");

        [STAThread]
        public static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            bool probeOnly = false;
            bool playTestTone = false;
            int durationMs = 0;

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--probe") probeOnly = true;
                else if (args[i] == "--play-test-tone") playTestTone = true;
                else if (args[i] == "--duration-ms" && i + 1 < args.Length)
                {
                    int.TryParse(args[++i], out durationMs);
                }
            }

            try
            {
                var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                IMMDevice device;
                int hr = enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out device);
                if (hr != 0 || device == null)
                {
                    Console.WriteLine("{\"type\":\"error\",\"stage\":\"GetDefaultAudioEndpoint\",\"hresult\":" + hr + "}");
                    return 1;
                }

                string endpointId;
                device.GetId(out endpointId);

                object audioClientObj;
                hr = device.Activate(ref IID_IAudioClient, CLSCTX_ALL, IntPtr.Zero, out audioClientObj);
                if (hr != 0 || audioClientObj == null)
                {
                    Console.WriteLine("{\"type\":\"error\",\"stage\":\"Activate_IAudioClient\",\"hresult\":" + hr + "}");
                    return 1;
                }

                var audioClient = (IAudioClient)audioClientObj;
                IntPtr mixFormatPtr;
                hr = audioClient.GetMixFormat(out mixFormatPtr);
                if (hr != 0 || mixFormatPtr == IntPtr.Zero)
                {
                    Console.WriteLine("{\"type\":\"error\",\"stage\":\"GetMixFormat\",\"hresult\":" + hr + "}");
                    return 1;
                }

                WAVEFORMATEX fmt = (WAVEFORMATEX)Marshal.PtrToStructure(mixFormatPtr, typeof(WAVEFORMATEX));

                if (probeOnly)
                {
                    Console.WriteLine(
                        "{\"type\":\"probe\",\"ok\":true,\"endpointId\":\"" + EscapeJson(endpointId ?? "") +
                        "\",\"sampleRate\":" + fmt.nSamplesPerSec +
                        ",\"channels\":" + fmt.nChannels +
                        ",\"bitsPerSample\":" + fmt.wBitsPerSample +
                        ",\"blockAlign\":" + fmt.nBlockAlign + "}"
                    );
                    Marshal.FreeCoTaskMem(mixFormatPtr);
                    return 0;
                }

                // Initialize WASAPI Loopback Capture Client (100ms buffer = 1,000,000 hns)
                hr = audioClient.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    1000000,
                    0,
                    mixFormatPtr,
                    IntPtr.Zero
                );
                if (hr != 0)
                {
                    Console.WriteLine("{\"type\":\"error\",\"stage\":\"Initialize_Loopback\",\"hresult\":" + hr + "}");
                    Marshal.FreeCoTaskMem(mixFormatPtr);
                    return 1;
                }

                object captureObj;
                hr = audioClient.GetService(ref IID_IAudioCaptureClient, out captureObj);
                if (hr != 0 || captureObj == null)
                {
                    Console.WriteLine("{\"type\":\"error\",\"stage\":\"GetService_IAudioCaptureClient\",\"hresult\":" + hr + "}");
                    Marshal.FreeCoTaskMem(mixFormatPtr);
                    return 1;
                }
                var captureClient = (IAudioCaptureClient)captureObj;

                // Optional companion WASAPI Render Client on the same endpoint
                // Plays a gentle non-sensitive 440Hz test tone (or zero-amplitude keepalive)
                // so Windows WASAPI loopback always delivers active packets even if no other app is playing sound.
                IAudioClient renderAudioClient = null;
                IAudioRenderClient renderClient = null;
                uint renderBufferFrames = 0;
                double tonePhase = 0.0;

                object renderAudioObj;
                if (device.Activate(ref IID_IAudioClient, CLSCTX_ALL, IntPtr.Zero, out renderAudioObj) == 0 && renderAudioObj != null)
                {
                    renderAudioClient = (IAudioClient)renderAudioObj;
                    if (renderAudioClient.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1000000, 0, mixFormatPtr, IntPtr.Zero) == 0)
                    {
                        renderAudioClient.GetBufferSize(out renderBufferFrames);
                        object renderServiceObj;
                        if (renderAudioClient.GetService(ref IID_IAudioRenderClient, out renderServiceObj) == 0 && renderServiceObj != null)
                        {
                            renderClient = (IAudioRenderClient)renderServiceObj;
                            renderAudioClient.Start();
                        }
                    }
                }

                hr = audioClient.Start();
                if (hr != 0)
                {
                    Console.WriteLine("{\"type\":\"error\",\"stage\":\"Start_Loopback\",\"hresult\":" + hr + "}");
                    Marshal.FreeCoTaskMem(mixFormatPtr);
                    return 1;
                }

                Console.WriteLine(
                    "{\"type\":\"started\",\"endpointId\":\"" + EscapeJson(endpointId ?? "") +
                    "\",\"sampleRate\":" + fmt.nSamplesPerSec +
                    ",\"channels\":" + fmt.nChannels +
                    ",\"bitsPerSample\":" + fmt.wBitsPerSample +
                    ",\"playTestTone\":" + (playTestTone ? "true" : "false") + "}"
                );
                Console.Out.Flush();

                int channels = Math.Max(1, (int)fmt.nChannels);
                int bytesPerSample = Math.Max(2, fmt.wBitsPerSample / 8);
                int sampleRate = (int)fmt.nSamplesPerSec;

                // Downsample/chunk accumulator for mono float32 frames sent to Renderer
                const int targetChunkFrames = 960; // 20ms at 48kHz
                float[] monoChunk = new float[targetChunkFrames];
                int monoChunkIndex = 0;
                double sumSquares = 0.0;
                float peak = 0.0f;

                DateTime startTime = DateTime.UtcNow;

                while (true)
                {
                    if (durationMs > 0 && (DateTime.UtcNow - startTime).TotalMilliseconds >= durationMs)
                    {
                        break;
                    }

                    // Feed render client (either audible 440Hz harmonic chime if playTestTone is true, or silent keepalive)
                    if (renderAudioClient != null && renderClient != null && bytesPerSample == 4)
                    {
                        uint padding;
                        if (renderAudioClient.GetCurrentPadding(out padding) == 0)
                        {
                            uint avail = renderBufferFrames > padding ? renderBufferFrames - padding : 0;
                            uint toWrite = Math.Min(avail, (uint)(sampleRate / 25));
                            if (toWrite > 0)
                            {
                                IntPtr renderBuf;
                                if (renderClient.GetBuffer(toWrite, out renderBuf) == 0 && renderBuf != IntPtr.Zero)
                                {
                                    float[] tempRender = new float[toWrite * channels];
                                    double phaseInc = 2.0 * Math.PI * 440.0 / sampleRate;
                                    for (int f = 0; f < toWrite; f++)
                                    {
                                        float sample = playTestTone ? (float)(Math.Sin(tonePhase) * 0.18) : 0.0f;
                                        tonePhase += phaseInc;
                                        if (tonePhase > 2.0 * Math.PI) tonePhase -= 2.0 * Math.PI;
                                        for (int c = 0; c < channels; c++)
                                        {
                                            tempRender[f * channels + c] = sample;
                                        }
                                    }
                                    Marshal.Copy(tempRender, 0, renderBuf, tempRender.Length);
                                    renderClient.ReleaseBuffer(toWrite, playTestTone ? 0u : AUDCLNT_BUFFERFLAGS_SILENT);
                                }
                            }
                        }
                    }

                    uint packetSize = 0;
                    hr = captureClient.GetNextPacketSize(out packetSize);
                    if (hr != 0) break;

                    while (packetSize > 0)
                    {
                        IntPtr dataPtr;
                        uint numFrames;
                        uint flags;
                        ulong devPos;
                        ulong qpcPos;

                        hr = captureClient.GetBuffer(out dataPtr, out numFrames, out flags, out devPos, out qpcPos);
                        if (hr != 0) break;

                        bool isSilent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;
                        int totalSamples = (int)numFrames * channels;

                        if (numFrames > 0)
                        {
                            float[] packetFloats = new float[totalSamples];
                            if (!isSilent && bytesPerSample == 4 && dataPtr != IntPtr.Zero)
                            {
                                Marshal.Copy(dataPtr, packetFloats, 0, totalSamples);
                            }

                            for (int f = 0; f < numFrames; f++)
                            {
                                float mono = 0.0f;
                                if (!isSilent)
                                {
                                    int baseIdx = f * channels;
                                    for (int c = 0; c < channels; c++)
                                    {
                                        mono += packetFloats[baseIdx + c];
                                    }
                                    mono /= channels;
                                }

                                float abs = Math.Abs(mono);
                                if (abs > peak) peak = abs;
                                sumSquares += (double)mono * mono;

                                monoChunk[monoChunkIndex++] = mono;
                                if (monoChunkIndex >= targetChunkFrames)
                                {
                                    double rms = Math.Sqrt(sumSquares / targetChunkFrames);
                                    byte[] rawBytes = new byte[targetChunkFrames * 4];
                                    Buffer.BlockCopy(monoChunk, 0, rawBytes, 0, rawBytes.Length);
                                    string b64 = Convert.ToBase64String(rawBytes);

                                    Console.WriteLine(
                                        "{\"type\":\"chunk\",\"sampleRate\":" + sampleRate +
                                        ",\"frames\":" + targetChunkFrames +
                                        ",\"rms\":" + rms.ToString("F6", System.Globalization.CultureInfo.InvariantCulture) +
                                        ",\"peak\":" + peak.ToString("F6", System.Globalization.CultureInfo.InvariantCulture) +
                                        ",\"pcmFloat32Base64\":\"" + b64 + "\"}"
                                    );
                                    Console.Out.Flush();

                                    monoChunkIndex = 0;
                                    sumSquares = 0.0;
                                    peak = 0.0f;
                                }
                            }
                        }

                        captureClient.ReleaseBuffer(numFrames);
                        hr = captureClient.GetNextPacketSize(out packetSize);
                        if (hr != 0) break;
                    }

                    Thread.Sleep(12);
                }

                audioClient.Stop();
                if (renderAudioClient != null) renderAudioClient.Stop();
                Marshal.FreeCoTaskMem(mixFormatPtr);
                return 0;
            }
            catch (Exception ex)
            {
                Console.WriteLine("{\"type\":\"error\",\"stage\":\"exception\",\"message\":\"" + EscapeJson(ex.Message) + "\"}");
                return 1;
            }
        }

        private static string EscapeJson(string s)
        {
            return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
        }
    }
}
