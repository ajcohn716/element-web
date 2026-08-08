/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

using System;
using System.Diagnostics;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Program
{
    private const uint ProcessQueryLimitedInformation = 0x1000;
    private const uint AudioClientStreamFlagsLoopback = 0x00020000;
    private const uint AudioClientStreamFlagsEventCallback = 0x00040000;
    private const uint AudioClientStreamFlagsSourceDefaultQuality = 0x08000000;
    private const uint AudioClientStreamFlagsAutoConvertPcm = 0x80000000;
    private const uint AudioClientBufferFlagsDataDiscontinuity = 0x1;
    private const uint AudioClientBufferFlagsSilent = 0x2;
    private const ushort WaveFormatPcm = 1;
    private const ushort VariantBlob = 65;
    private const int AudioClientActivationTypeProcessLoopback = 1;
    private const string VirtualAudioDeviceProcessLoopback = "VAD\\Process_Loopback";

    private static readonly Guid AudioClientInterfaceId = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    private static readonly Guid AudioCaptureClientInterfaceId = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    private static volatile bool stopRequested;

    private static int Main(string[] args)
    {
        if (!Environment.Is64BitProcess)
        {
            return Fail("This experiment must run as a 64-bit process.");
        }

        if (args.Length == 2 && string.Equals(args[0], "source", StringComparison.OrdinalIgnoreCase))
        {
            return ResolveSource(args[1]);
        }

        if (args.Length == 3 && string.Equals(args[0], "tone", StringComparison.OrdinalIgnoreCase))
        {
            return PlayTone(args[1], args[2]);
        }

        if (args.Length == 4 && string.Equals(args[0], "tone-tree", StringComparison.OrdinalIgnoreCase))
        {
            return PlayToneFromChild(args[1], args[2], args[3]);
        }

        if (args.Length >= 4 && args.Length <= 5 &&
            string.Equals(args[0], "capture", StringComparison.OrdinalIgnoreCase))
        {
            uint processId;
            if (!uint.TryParse(args[1], out processId) || processId == 0)
            {
                return Fail("PID must be a positive decimal integer.");
            }

            bool include;
            if (string.Equals(args[2], "include", StringComparison.OrdinalIgnoreCase))
            {
                include = true;
            }
            else if (string.Equals(args[2], "exclude", StringComparison.OrdinalIgnoreCase))
            {
                include = false;
            }
            else
            {
                return Fail("Capture mode must be 'include' or 'exclude'.");
            }

            int durationSeconds = 10;
            if (args.Length == 5 && (!int.TryParse(args[4], out durationSeconds) || durationSeconds <= 0))
            {
                return Fail("Duration must be a positive number of seconds.");
            }

            return Capture(processId, include, args[3], durationSeconds);
        }

        PrintUsage();
        return 2;
    }

    private static int ResolveSource(string sourceId)
    {
        string[] components = sourceId.Split(':');
        ulong rawHandle;
        if (components.Length != 3 || components[0] != "window" ||
            !ulong.TryParse(components[1], out rawHandle) || rawHandle == 0)
        {
            return Fail("Expected an Electron window source ID such as window:525386:0.");
        }

        IntPtr windowHandle = new IntPtr(unchecked((long)rawHandle));
        uint processId;
        uint threadId = GetWindowThreadProcessId(windowHandle, out processId);
        if (threadId == 0 || processId == 0)
        {
            return Fail("GetWindowThreadProcessId failed for HWND " + rawHandle + ".");
        }

        string executable = GetExecutableBasename(processId);
        Console.WriteLine("sourceId={0}", sourceId);
        Console.WriteLine("hwnd={0}", rawHandle);
        Console.WriteLine("pid={0}", processId);
        Console.WriteLine("executable={0}", executable ?? "unavailable");
        return 0;
    }

    private static int Capture(uint processId, bool include, string outputPath, int durationSeconds)
    {
        Process target;
        try
        {
            target = Process.GetProcessById(checked((int)processId));
            if (target.HasExited)
            {
                return Fail("Target process has already exited.");
            }
        }
        catch (Exception error)
        {
            return Fail("Target PID is not running: " + error.Message);
        }

        string fullOutputPath = Path.GetFullPath(outputPath);
        string outputDirectory = Path.GetDirectoryName(fullOutputPath);
        if (!string.IsNullOrEmpty(outputDirectory))
        {
            Directory.CreateDirectory(outputDirectory);
        }

        int initializeResult = CoInitializeEx(IntPtr.Zero, 0);
        if (initializeResult < 0 && initializeResult != unchecked((int)0x80010106))
        {
            return FailHResult("CoInitializeEx", initializeResult);
        }

        bool uninitializeCom = initializeResult >= 0;
        try
        {
            using (AutoResetEvent samplesReady = new AutoResetEvent(false))
            using (ManualResetEvent activationCompleted = new ManualResetEvent(false))
            using (FileStream output = new FileStream(fullOutputPath, FileMode.Create, FileAccess.ReadWrite, FileShare.Read))
            using (BinaryWriter writer = new BinaryWriter(output, Encoding.ASCII))
            {
                CompletionHandler completionHandler = new CompletionHandler(activationCompleted);
                IntPtr activationData = IntPtr.Zero;
                IntPtr completionHandlerPointer = IntPtr.Zero;
                IntPtr operationPointer = IntPtr.Zero;
                try
                {
                    activationData = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(AudioClientActivationParams)));
                    AudioClientActivationParams activationParams = new AudioClientActivationParams();
                    activationParams.ActivationType = AudioClientActivationTypeProcessLoopback;
                    activationParams.TargetProcessId = processId;
                    activationParams.ProcessLoopbackMode = include ? 0 : 1;
                    Marshal.StructureToPtr(activationParams, activationData, false);

                    PropVariant propVariant = new PropVariant();
                    propVariant.VariantType = VariantBlob;
                    propVariant.Blob = new Blob((uint)Marshal.SizeOf(typeof(AudioClientActivationParams)), activationData);

                    Guid audioClientInterfaceId = AudioClientInterfaceId;
                    completionHandlerPointer = Marshal.GetComInterfaceForObject(
                        completionHandler,
                        typeof(IActivateAudioInterfaceCompletionHandler));
                    Guid agileObjectInterfaceId = new Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90");
                    IntPtr agileObjectPointer;
                    int agileQueryResult = Marshal.QueryInterface(
                        completionHandlerPointer,
                        ref agileObjectInterfaceId,
                        out agileObjectPointer);
                    if (agileQueryResult < 0)
                    {
                        return FailHResult("Completion-handler IAgileObject query", agileQueryResult);
                    }
                    Marshal.Release(agileObjectPointer);

                    int activateResult = ActivateAudioInterfaceAsync(
                        VirtualAudioDeviceProcessLoopback,
                        ref audioClientInterfaceId,
                        ref propVariant,
                        completionHandlerPointer,
                        out operationPointer);
                    if (activateResult < 0)
                    {
                        return FailHResult("ActivateAudioInterfaceAsync", activateResult);
                    }

                    if (!activationCompleted.WaitOne(TimeSpan.FromSeconds(10)))
                    {
                        return Fail("Timed out waiting for process-loopback activation.");
                    }

                    if (completionHandler.Result < 0)
                    {
                        return FailHResult("Process-loopback activation", completionHandler.Result);
                    }
                }
                finally
                {
                    if (activationData != IntPtr.Zero)
                    {
                        Marshal.FreeCoTaskMem(activationData);
                    }
                    if (operationPointer != IntPtr.Zero)
                    {
                        Marshal.Release(operationPointer);
                    }
                    if (completionHandlerPointer != IntPtr.Zero)
                    {
                        Marshal.Release(completionHandlerPointer);
                    }
                }

                IAudioClient audioClient = (IAudioClient)completionHandler.AudioClient;
                WaveFormat captureFormat = WaveFormat.CreatePcm(48000, 2, 16);
                IntPtr formatPointer = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WaveFormat)));
                IAudioCaptureClient captureClient = null;
                try
                {
                    string wasapiMixFormat = GetMixFormatDescription(audioClient);
                    Marshal.StructureToPtr(captureFormat, formatPointer, false);
                    uint streamFlags = AudioClientStreamFlagsLoopback |
                        AudioClientStreamFlagsEventCallback |
                        AudioClientStreamFlagsAutoConvertPcm |
                        AudioClientStreamFlagsSourceDefaultQuality;
                    Guid sessionId = Guid.Empty;
                    CheckHResult("IAudioClient.Initialize", audioClient.Initialize(
                        0,
                        streamFlags,
                        0,
                        0,
                        formatPointer,
                        ref sessionId));
                    CheckHResult("IAudioClient.SetEventHandle", audioClient.SetEventHandle(samplesReady.SafeWaitHandle.DangerousGetHandle()));

                    object captureClientObject;
                    Guid captureInterfaceId = AudioCaptureClientInterfaceId;
                    CheckHResult("IAudioClient.GetService", audioClient.GetService(ref captureInterfaceId, out captureClientObject));
                    captureClient = (IAudioCaptureClient)captureClientObject;

                    WriteWaveHeader(writer, captureFormat, 0);
                    CheckHResult("IAudioClient.Start", audioClient.Start());

                    stopRequested = false;
                    Console.CancelKeyPress += OnCancelKeyPress;
                    Console.WriteLine("pid={0}", processId);
                    Console.WriteLine("executable={0}", GetExecutableBasename(processId) ?? "unavailable");
                    Console.WriteLine("mode={0}", include ? "include-target-process-tree" : "exclude-target-process-tree");
                    Console.WriteLine("wasapiMixFormat={0}", wasapiMixFormat);
                    Console.WriteLine("format=48000Hz stereo PCM16");
                    Console.WriteLine("output={0}", fullOutputPath);

                    long dataBytes = 0;
                    long sampleCount = 0;
                    double sampleSquareSum = 0;
                    int peakSample = 0;
                    int discontinuities = 0;
                    Stopwatch elapsed = Stopwatch.StartNew();
                    string stopReason = "duration elapsed";

                    while (!stopRequested && elapsed.Elapsed < TimeSpan.FromSeconds(durationSeconds))
                    {
                        try
                        {
                            if (target.HasExited)
                            {
                                stopReason = "target process exited";
                                break;
                            }
                        }
                        catch
                        {
                            stopReason = "target process became unavailable";
                            break;
                        }

                        samplesReady.WaitOne(250);
                        DrainPackets(
                            captureClient,
                            writer,
                            captureFormat.BlockAlign,
                            ref dataBytes,
                            ref sampleCount,
                            ref sampleSquareSum,
                            ref peakSample,
                            ref discontinuities);
                    }

                    if (stopRequested)
                    {
                        stopReason = "Ctrl+C";
                    }

                    int stopResult = audioClient.Stop();
                    if (stopResult < 0)
                    {
                        Console.Error.WriteLine("warning=IAudioClient.Stop failed with 0x{0:X8}", stopResult);
                    }

                    DrainPackets(
                        captureClient,
                        writer,
                        captureFormat.BlockAlign,
                        ref dataBytes,
                        ref sampleCount,
                        ref sampleSquareSum,
                        ref peakSample,
                        ref discontinuities);
                    PatchWaveHeader(writer, checked((uint)dataBytes));
                    writer.Flush();

                    double normalizedRms = sampleCount == 0 ? 0 : Math.Sqrt(sampleSquareSum / sampleCount) / 32768.0;
                    double normalizedPeak = peakSample / 32768.0;

                    Console.WriteLine("stopReason={0}", stopReason);
                    Console.WriteLine("capturedBytes={0}", dataBytes);
                    Console.WriteLine("normalizedRms={0:F8}", normalizedRms);
                    Console.WriteLine("normalizedPeak={0:F8}", normalizedPeak);
                    Console.WriteLine("dataDiscontinuities={0}", discontinuities);
                    Console.WriteLine("silenceOnly={0}", normalizedRms < 0.0001 ? "true" : "false");
                    return 0;
                }
                catch (COMException error)
                {
                    return FailHResult(error.Message, error.ErrorCode);
                }
                finally
                {
                    Console.CancelKeyPress -= OnCancelKeyPress;
                    if (captureClient != null && Marshal.IsComObject(captureClient))
                    {
                        Marshal.FinalReleaseComObject(captureClient);
                    }
                    if (audioClient != null && Marshal.IsComObject(audioClient))
                    {
                        Marshal.FinalReleaseComObject(audioClient);
                    }
                    Marshal.FreeCoTaskMem(formatPointer);
                }
            }
        }
        catch (Exception error)
        {
            return Fail(error.Message);
        }
        finally
        {
            target.Dispose();
            if (uninitializeCom)
            {
                CoUninitialize();
            }
        }
    }

    private static int PlayTone(string frequencyArgument, string durationArgument)
    {
        int frequency;
        int durationSeconds;
        if (!int.TryParse(frequencyArgument, out frequency) || frequency < 20 || frequency > 20000)
        {
            return Fail("Tone frequency must be between 20 and 20000 Hz.");
        }
        if (!int.TryParse(durationArgument, out durationSeconds) || durationSeconds <= 0)
        {
            return Fail("Tone duration must be a positive number of seconds.");
        }

        const int sampleRate = 48000;
        const ushort channels = 2;
        const ushort bitsPerSample = 16;
        int frameCount = checked(sampleRate * durationSeconds);
        int dataBytes = checked(frameCount * channels * bitsPerSample / 8);
        using (MemoryStream wave = new MemoryStream(44 + dataBytes))
        using (BinaryWriter writer = new BinaryWriter(wave, Encoding.ASCII, true))
        {
            WriteWaveHeader(writer, WaveFormat.CreatePcm(sampleRate, channels, bitsPerSample), (uint)dataBytes);
            double angularStep = 2.0 * Math.PI * frequency / sampleRate;
            for (int frame = 0; frame < frameCount; frame++)
            {
                short sample = (short)(Math.Sin(frame * angularStep) * short.MaxValue * 0.2);
                writer.Write(sample);
                writer.Write(sample);
            }
            writer.Flush();
            wave.Position = 0;
            Console.WriteLine("pid={0}", Process.GetCurrentProcess().Id);
            Console.WriteLine("toneHz={0}", frequency);
            using (SoundPlayer player = new SoundPlayer(wave))
            {
                player.PlaySync();
            }
        }
        return 0;
    }

    private static int PlayToneFromChild(string frequencyArgument, string delayArgument, string durationArgument)
    {
        int delaySeconds;
        if (!int.TryParse(delayArgument, out delaySeconds) || delaySeconds < 0)
        {
            return Fail("Child delay must be a non-negative number of seconds.");
        }

        Console.WriteLine("parentPid={0}", Process.GetCurrentProcess().Id);
        Thread.Sleep(TimeSpan.FromSeconds(delaySeconds));

        ProcessStartInfo startInfo = new ProcessStartInfo();
        startInfo.FileName = Process.GetCurrentProcess().MainModule.FileName;
        startInfo.Arguments = string.Format("tone {0} {1}", frequencyArgument, durationArgument);
        startInfo.UseShellExecute = false;
        using (Process child = Process.Start(startInfo))
        {
            Console.WriteLine("childPid={0}", child.Id);
            child.WaitForExit();
            return child.ExitCode;
        }
    }

    private static void DrainPackets(
        IAudioCaptureClient captureClient,
        BinaryWriter writer,
        ushort blockAlign,
        ref long dataBytes,
        ref long sampleCount,
        ref double sampleSquareSum,
        ref int peakSample,
        ref int discontinuities)
    {
        uint nextPacketFrames;
        CheckHResult("IAudioCaptureClient.GetNextPacketSize", captureClient.GetNextPacketSize(out nextPacketFrames));
        while (nextPacketFrames > 0)
        {
            IntPtr data;
            uint frames;
            uint flags;
            ulong devicePosition;
            ulong performanceCounterPosition;
            CheckHResult("IAudioCaptureClient.GetBuffer", captureClient.GetBuffer(
                out data,
                out frames,
                out flags,
                out devicePosition,
                out performanceCounterPosition));

            try
            {
                int byteCount = checked((int)(frames * blockAlign));
                byte[] bytes = new byte[byteCount];
                if ((flags & AudioClientBufferFlagsSilent) == 0 && data != IntPtr.Zero)
                {
                    Marshal.Copy(data, bytes, 0, byteCount);
                }
                for (int index = 0; index < bytes.Length; index += 2)
                {
                    int sample = BitConverter.ToInt16(bytes, index);
                    int absoluteSample = Math.Abs(sample);
                    sampleSquareSum += (double)sample * sample;
                    sampleCount++;
                    if (absoluteSample > peakSample)
                    {
                        peakSample = absoluteSample;
                    }
                }
                if ((flags & AudioClientBufferFlagsDataDiscontinuity) != 0)
                {
                    discontinuities++;
                }
                writer.Write(bytes);
                dataBytes += byteCount;
            }
            finally
            {
                CheckHResult("IAudioCaptureClient.ReleaseBuffer", captureClient.ReleaseBuffer(frames));
            }

            CheckHResult("IAudioCaptureClient.GetNextPacketSize", captureClient.GetNextPacketSize(out nextPacketFrames));
        }
    }

    private static void WriteWaveHeader(BinaryWriter writer, WaveFormat format, uint dataBytes)
    {
        writer.Write(Encoding.ASCII.GetBytes("RIFF"));
        writer.Write(36u + dataBytes);
        writer.Write(Encoding.ASCII.GetBytes("WAVE"));
        writer.Write(Encoding.ASCII.GetBytes("fmt "));
        writer.Write(16u);
        writer.Write(format.FormatTag);
        writer.Write(format.Channels);
        writer.Write(format.SamplesPerSecond);
        writer.Write(format.AverageBytesPerSecond);
        writer.Write(format.BlockAlign);
        writer.Write(format.BitsPerSample);
        writer.Write(Encoding.ASCII.GetBytes("data"));
        writer.Write(dataBytes);
    }

    private static string GetMixFormatDescription(IAudioClient audioClient)
    {
        IntPtr mixFormatPointer;
        int result = audioClient.GetMixFormat(out mixFormatPointer);
        if (result < 0)
        {
            return string.Format("unavailable (HRESULT 0x{0:X8})", result);
        }
        try
        {
            ushort formatTag = unchecked((ushort)Marshal.ReadInt16(mixFormatPointer, 0));
            ushort channels = unchecked((ushort)Marshal.ReadInt16(mixFormatPointer, 2));
            uint sampleRate = unchecked((uint)Marshal.ReadInt32(mixFormatPointer, 4));
            ushort bitsPerSample = unchecked((ushort)Marshal.ReadInt16(mixFormatPointer, 14));
            ushort extraSize = unchecked((ushort)Marshal.ReadInt16(mixFormatPointer, 16));
            string formatName;
            if (formatTag == 1)
            {
                formatName = "PCM";
            }
            else if (formatTag == 3)
            {
                formatName = "IEEE_FLOAT";
            }
            else if (formatTag == 0xFFFE && extraSize >= 22)
            {
                IntPtr subformatPointer = new IntPtr(mixFormatPointer.ToInt64() + 24);
                Guid subformat = (Guid)Marshal.PtrToStructure(subformatPointer, typeof(Guid));
                formatName = "EXTENSIBLE(" + subformat + ")";
            }
            else
            {
                formatName = "tag-0x" + formatTag.ToString("X4");
            }

            return string.Format("{0}Hz {1}ch {2}-bit {3}", sampleRate, channels, bitsPerSample, formatName);
        }
        finally
        {
            Marshal.FreeCoTaskMem(mixFormatPointer);
        }
    }

    private static void PatchWaveHeader(BinaryWriter writer, uint dataBytes)
    {
        writer.BaseStream.Seek(4, SeekOrigin.Begin);
        writer.Write(36u + dataBytes);
        writer.BaseStream.Seek(40, SeekOrigin.Begin);
        writer.Write(dataBytes);
        writer.BaseStream.Seek(0, SeekOrigin.End);
    }

    private static string GetExecutableBasename(uint processId)
    {
        IntPtr processHandle = OpenProcess(ProcessQueryLimitedInformation, false, processId);
        if (processHandle == IntPtr.Zero)
        {
            return null;
        }

        try
        {
            uint capacity = 32768;
            StringBuilder path = new StringBuilder((int)capacity);
            if (!QueryFullProcessImageName(processHandle, 0, path, ref capacity))
            {
                return null;
            }
            return Path.GetFileName(path.ToString());
        }
        finally
        {
            CloseHandle(processHandle);
        }
    }

    private static void CheckHResult(string operation, int result)
    {
        if (result < 0)
        {
            throw new COMException(operation, result);
        }
    }

    private static int FailHResult(string operation, int result)
    {
        return Fail(string.Format("{0} failed with HRESULT 0x{1:X8}: {2}", operation, result, Marshal.GetExceptionForHR(result).Message));
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine("error={0}", message);
        return 1;
    }

    private static void OnCancelKeyPress(object sender, ConsoleCancelEventArgs eventArgs)
    {
        eventArgs.Cancel = true;
        stopRequested = true;
    }

    private static void PrintUsage()
    {
        Console.Error.WriteLine("Usage:");
        Console.Error.WriteLine("  windows-process-loopback source <window-source-id>");
        Console.Error.WriteLine("  windows-process-loopback capture <pid> <include|exclude> <output.wav> [seconds]");
        Console.Error.WriteLine("  windows-process-loopback tone <frequency-hz> <seconds>");
        Console.Error.WriteLine("  windows-process-loopback tone-tree <frequency-hz> <delay-seconds> <seconds>");
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientActivationParams
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int ProcessLoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Blob
    {
        public uint Size;
        public IntPtr Data;

        public Blob(uint size, IntPtr data)
        {
            Size = size;
            Data = data;
        }
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant
    {
        [FieldOffset(0)]
        public ushort VariantType;

        [FieldOffset(8)]
        public Blob Blob;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSecond;
        public uint AverageBytesPerSecond;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort ExtraSize;

        public static WaveFormat CreatePcm(uint sampleRate, ushort channels, ushort bitsPerSample)
        {
            WaveFormat result = new WaveFormat();
            result.FormatTag = WaveFormatPcm;
            result.Channels = channels;
            result.SamplesPerSecond = sampleRate;
            result.BitsPerSample = bitsPerSample;
            result.BlockAlign = (ushort)(channels * bitsPerSample / 8);
            result.AverageBytesPerSecond = sampleRate * result.BlockAlign;
            result.ExtraSize = 0;
            return result;
        }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    public sealed class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        private readonly EventWaitHandle completed;

        public CompletionHandler(EventWaitHandle completedEvent)
        {
            completed = completedEvent;
            Result = unchecked((int)0x8000FFFF);
        }

        public int Result { get; private set; }
        public object AudioClient { get; private set; }

        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                int activationResult;
                object audioClient;
                int operationResult = operation.GetActivateResult(out activationResult, out audioClient);
                Result = operationResult < 0 ? operationResult : activationResult;
                AudioClient = audioClient;
            }
            catch (Exception error)
            {
                Result = Marshal.GetHRForException(error);
            }
            finally
            {
                completed.Set();
            }
            return 0;
        }
    }

    [ComImport]
    [Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig]
        int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComVisible(true)]
    [Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig]
        int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComVisible(true)]
    [Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAgileObject
    {
    }

    [ComImport]
    [Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig]
        int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, ref Guid audioSessionGuid);
        [PreserveSig]
        int GetBufferSize(out uint bufferFrameCount);
        [PreserveSig]
        int GetStreamLatency(out long latency);
        [PreserveSig]
        int GetCurrentPadding(out uint currentPaddingFrames);
        [PreserveSig]
        int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig]
        int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig]
        int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
        [PreserveSig]
        int Start();
        [PreserveSig]
        int Stop();
        [PreserveSig]
        int Reset();
        [PreserveSig]
        int SetEventHandle(IntPtr eventHandle);
        [PreserveSig]
        int GetService(ref Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport]
    [Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr data, out uint framesToRead, out uint flags, out ulong devicePosition, out ulong performanceCounterPosition);
        [PreserveSig]
        int ReleaseBuffer(uint framesRead);
        [PreserveSig]
        int GetNextPacketSize(out uint nextPacketSize);
    }

    [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int ActivateAudioInterfaceAsync(
        string deviceInterfacePath,
        ref Guid interfaceId,
        ref PropVariant activationParams,
        IntPtr completionHandler,
        out IntPtr activationOperation);

    [DllImport("ole32.dll")]
    private static extern int CoInitializeEx(IntPtr reserved, uint concurrencyModel);

    [DllImport("ole32.dll")]
    private static extern void CoUninitialize();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr windowHandle, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr processHandle, uint flags, StringBuilder executableName, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
