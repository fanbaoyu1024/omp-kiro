export interface KiroEventStreamMessage {
    headers: Record<string, string>;
    payload: Uint8Array;
}
export declare function crc32(bytes: Uint8Array): number;
export declare function decodeKiroEventStreamMessage(frame: Uint8Array): KiroEventStreamMessage;
export declare function decodeKiroEventStream(source: ReadableStream<Uint8Array>): AsyncGenerator<KiroEventStreamMessage>;
//# sourceMappingURL=eventstream.d.ts.map