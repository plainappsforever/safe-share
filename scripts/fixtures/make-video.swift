// Writes 2 s 320x240 H.264 + AAC (silence) videos with known hidden metadata (AVAssetWriter).
// Usage: swiftc -O scripts/fixtures/make-video.swift -o <tmp>/make-video && <tmp>/make-video test/fixtures
// Outputs: gps.mov (QuickTime metadata keys/ilst) and gps.mp4 (QuickTime user data where the writer allows).
// V1.5-1: `<tmp>/make-video test/fixtures v15` writes only video.3gp (AVAssetWriter's 3GPP writer, 3GPP user data).
import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "test/fixtures"
let W = 320, H = 240, FPS: Int32 = 15, SECONDS = 2
let SAMPLE_RATE = 44100.0
let MODE = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "v1"

func item(_ id: AVMetadataIdentifier, _ value: String, keySpace: AVMetadataKeySpace? = nil) -> AVMetadataItem {
    let m = AVMutableMetadataItem()
    m.identifier = id
    m.value = value as NSString
    m.dataType = "com.apple.metadata.datatype.UTF-8"
    return m
}

func makeFrame(pool: CVPixelBufferPool, index: Int) -> CVPixelBuffer {
    var pb: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
    let buf = pb!
    CVPixelBufferLockBaseAddress(buf, [])
    let base = CVPixelBufferGetBaseAddress(buf)!.assumingMemoryBound(to: UInt8.self)
    let stride = CVPixelBufferGetBytesPerRow(buf)
    for y in 0..<H {
        for x in 0..<W {
            let o = y * stride + x * 4  // BGRA
            base[o] = UInt8((x + index * 8) % 256)
            base[o + 1] = UInt8((y * 255) / H)
            base[o + 2] = UInt8(((x / 32 + y / 32 + index) % 2) * 160 + 40)
            base[o + 3] = 255
        }
    }
    CVPixelBufferUnlockBaseAddress(buf, [])
    return buf
}

func silence(frames: Int, at start: Int64, fmt: CMAudioFormatDescription) -> CMSampleBuffer {
    let bytes = frames * 2
    var block: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
                                       customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block)
    CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes)
    var sb: CMSampleBuffer?
    CMAudioSampleBufferCreateReadyWithPacketDescriptions(
        allocator: nil, dataBuffer: block!, formatDescription: fmt, sampleCount: frames,
        presentationTimeStamp: CMTime(value: start, timescale: Int32(SAMPLE_RATE)), packetDescriptions: nil, sampleBufferOut: &sb)
    return sb!
}

func write(name: String, type: AVFileType, metadata: [AVMetadataItem], audio: Bool = true) {
    let url = URL(fileURLWithPath: outDir).appendingPathComponent(name)
    try? FileManager.default.removeItem(at: url)
    let writer = try! AVAssetWriter(outputURL: url, fileType: type)
    writer.metadata = metadata
    let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 300_000, AVVideoMaxKeyFrameIntervalKey: 15],
    ])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
    var asbd = AudioStreamBasicDescription(mSampleRate: SAMPLE_RATE, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked, mBytesPerPacket: 2, mFramesPerPacket: 1,
        mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
    var fmt: CMAudioFormatDescription?
    CMAudioFormatDescriptionCreate(allocator: nil, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil,
                                   extensions: nil, formatDescriptionOut: &fmt)
    let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: SAMPLE_RATE, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 32000,
    ])
    writer.add(vIn)
    if audio { writer.add(aIn) }
    guard writer.startWriting() else { print("FAILED start \(name): \(String(describing: writer.error))"); return }
    writer.startSession(atSourceTime: .zero)
    for i in 0..<(Int(FPS) * SECONDS) {
        while !vIn.isReadyForMoreMediaData {
            if writer.status == .failed { print("FAILED \(name): \(String(describing: writer.error))"); return }
            usleep(1000)
        }
        adaptor.append(makeFrame(pool: adaptor.pixelBufferPool!, index: i), withPresentationTime: CMTime(value: Int64(i), timescale: FPS))
    }
    vIn.markAsFinished()
    // 3GPP: the writer waits for interleaved audio, so the 3GP fixture is video only (V1.5-1).
    let chunk = 1024, total = audio ? Int(SAMPLE_RATE) * SECONDS : 0
    var pos = 0
    while pos < total {
        while !aIn.isReadyForMoreMediaData {
            if writer.status == .failed { print("FAILED \(name): \(String(describing: writer.error))"); return }
            usleep(1000)
        }
        let n = min(chunk, total - pos)
        aIn.append(silence(frames: n, at: Int64(pos), fmt: fmt!))
        pos += n
    }
    if audio { aIn.markAsFinished() }
    let sem = DispatchSemaphore(value: 0)
    writer.finishWriting { sem.signal() }
    sem.wait()
    print(writer.status == .completed ? "wrote \(name)" : "FAILED \(name): \(String(describing: writer.error))")
}

if MODE == "v15" {
    // 3GPP (X3): the writer turns these into udta 3GPP atoms (loci, titl, auth, cprt, dscp, yrrc) where it supports them.
    write(name: "video.3gp", type: .mobile3GPP, metadata: [
        item(.quickTimeUserDataLocationISO6709, "+48.8584+002.2945+035.000/"),
        item(.identifier3GPUserDataTitle, "Fixture 3GP secret title"),
        item(.identifier3GPUserDataAuthor, "Jane Fixture 3GP"),
        item(.identifier3GPUserDataCopyright, "(c) Jane Fixture 3GP"),
        item(.identifier3GPUserDataDescription, "Fixture 3GP description"),
        item(.quickTimeUserDataCreationDate, "2025-06-14T09:30:15+0200"),
    ], audio: false)
    exit(0)
}

// QuickTime metadata (mdta keys + ilst), as an iPhone writes them.
write(name: "gps.mov", type: .mov, metadata: [
    item(.quickTimeMetadataLocationISO6709, "+52.5200+013.4049+034.000/"),
    item(.quickTimeMetadataMake, "FixtureCam"),
    item(.quickTimeMetadataModel, "FC-1"),
    item(.quickTimeMetadataSoftware, "FixtureSoft 1.0"),
    item(.quickTimeMetadataCreationDate, "2025-06-14T09:30:15+0200"),
])
// MP4: QuickTime user data atoms (udta ©xyz / ©day); the writer may drop items it does not support.
write(name: "gps.mp4", type: .mp4, metadata: [
    item(.quickTimeUserDataLocationISO6709, "+52.5200+013.4049+034.000/"),
    item(.quickTimeUserDataCreationDate, "2025-06-14T09:30:15+0200"),
    item(.quickTimeMetadataMake, "FixtureCam"),
    item(.quickTimeMetadataModel, "FC-1"),
    item(.quickTimeMetadataSoftware, "FixtureSoft 1.0"),
])
