//! Length-prefixed frames: `u32 length | u8 type | u32 id | u32 jsonLength | json | payload` (docs/protocol.md).

use serde_json::Value;
use std::io::{self, Read, Write};

pub const REQUEST: u8 = 1;
pub const RESULT: u8 = 2;
pub const ERROR: u8 = 3;
pub const EVENT: u8 = 4;
pub const CANCEL: u8 = 5;
pub const PING: u8 = 6;

/// Largest frame either side accepts.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;
/// Type, request id and JSON length, excluding the outer length prefix.
pub const HEADER_SIZE: usize = 9;
/// Largest payload a response carries, leaving room for its JSON.
pub const MAX_PAYLOAD: usize = MAX_FRAME - 64 * 1024;

pub struct Frame {
    pub kind: u8,
    pub id: u32,
    pub json: Value,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: u8, id: u32, json: Value) -> Frame {
        Frame {
            kind,
            id,
            json,
            payload: Vec::new(),
        }
    }

    pub fn with_payload(kind: u8, id: u32, json: Value, payload: Vec<u8>) -> Frame {
        Frame {
            kind,
            id,
            json,
            payload,
        }
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// Read one frame; `None` at a clean end of input.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_be_bytes(length) as usize;
    if !(HEADER_SIZE..=MAX_FRAME).contains(&length) {
        return Err(invalid("frame length out of range"));
    }
    let mut body = vec![0u8; length];
    input.read_exact(&mut body)?;
    let kind = body[0];
    let id = u32::from_be_bytes([body[1], body[2], body[3], body[4]]);
    let json_length = u32::from_be_bytes([body[5], body[6], body[7], body[8]]) as usize;
    if HEADER_SIZE + json_length > length {
        return Err(invalid("JSON length out of range"));
    }
    // Unparseable JSON leaves the framing intact: the frame arrives with `Value::Null` and gets an error reply.
    let json = if json_length == 0 {
        Value::Object(Default::default())
    } else {
        serde_json::from_slice(&body[HEADER_SIZE..HEADER_SIZE + json_length]).unwrap_or(Value::Null)
    };
    // Shift the payload within its owned buffer rather than allocating a second copy.
    drop(body.drain(..HEADER_SIZE + json_length));
    // Queued payloads must not retain arbitrary JSON metadata after the request is acknowledged.
    let payload = if body.capacity() > body.len() * 2 {
        body.into_boxed_slice().into_vec()
    } else {
        body
    };
    Ok(Some(Frame {
        kind,
        id,
        json,
        payload,
    }))
}

pub fn write_frame(output: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let json = serde_json::to_vec(&frame.json).map_err(|_| invalid("unserializable JSON"))?;
    let length = HEADER_SIZE + json.len() + frame.payload.len();
    if length > MAX_FRAME {
        return Err(invalid("frame too large"));
    }
    let mut header = Vec::with_capacity(4 + HEADER_SIZE);
    header.extend_from_slice(&(length as u32).to_be_bytes());
    header.push(frame.kind);
    header.extend_from_slice(&frame.id.to_be_bytes());
    header.extend_from_slice(&(json.len() as u32).to_be_bytes());
    output.write_all(&header)?;
    output.write_all(&json)?;
    output.write_all(&frame.payload)?;
    output.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_json_and_payload() {
        let mut buffer = Vec::new();
        write_frame(
            &mut buffer,
            &Frame::with_payload(RESULT, 7, json!({ "a": 1 }), vec![0, 255, 10]),
        )
        .unwrap();
        write_frame(&mut buffer, &Frame::new(REQUEST, 8, json!({ "b": 2 }))).unwrap();
        let mut input = buffer.as_slice();
        let frame = read_frame(&mut input).unwrap().unwrap();
        let next = read_frame(&mut input).unwrap().unwrap();
        assert_eq!((frame.kind, frame.id), (RESULT, 7));
        assert_eq!(frame.json, json!({ "a": 1 }));
        assert_eq!(frame.payload, vec![0, 255, 10]);
        assert_eq!((next.kind, next.id), (REQUEST, 8));
        assert_eq!(next.json, json!({ "b": 2 }));
        assert!(next.payload.is_empty());
        assert!(read_frame(&mut input).unwrap().is_none());
    }

    #[test]
    fn bounds_retained_payload_storage_when_metadata_is_large() {
        // PTY input queues retain the payload after acknowledging and discarding its JSON metadata.
        for payload in [vec![], vec![255], vec![0, 255, 10]] {
            let expected = Frame::with_payload(
                REQUEST,
                7,
                json!({ "op": "ptyWrite", "target": 1, "padding": "x".repeat(1024 * 1024) }),
                payload,
            );
            let mut wire = Vec::new();
            write_frame(&mut wire, &expected).unwrap();
            let frame = read_frame(&mut wire.as_slice()).unwrap().unwrap();
            assert_eq!(frame.json, expected.json);
            assert_eq!(frame.payload, expected.payload);
            assert!(
                frame.payload.capacity() <= frame.payload.len() * 2,
                "payload of {} bytes retains {} bytes",
                frame.payload.len(),
                frame.payload.capacity()
            );
        }
    }

    #[test]
    fn keeps_empty_and_malformed_json_frames_aligned() {
        for json_bytes in [b"".as_slice(), b"{".as_slice(), &[0xff]] {
            let payload = [0, 255, 10];
            let length = HEADER_SIZE + json_bytes.len() + payload.len();
            let mut wire = (length as u32).to_be_bytes().to_vec();
            wire.push(REQUEST);
            wire.extend_from_slice(&7u32.to_be_bytes());
            wire.extend_from_slice(&(json_bytes.len() as u32).to_be_bytes());
            wire.extend_from_slice(json_bytes);
            wire.extend_from_slice(&payload);
            write_frame(&mut wire, &Frame::new(REQUEST, 8, json!({ "op": "hello" }))).unwrap();
            let mut input = wire.as_slice();
            let frame = read_frame(&mut input).unwrap().unwrap();
            let next = read_frame(&mut input).unwrap().unwrap();
            assert_eq!((frame.kind, frame.id), (REQUEST, 7));
            assert_eq!(
                frame.json,
                if json_bytes.is_empty() {
                    json!({})
                } else {
                    Value::Null
                }
            );
            assert_eq!(frame.payload, payload);
            assert_eq!(next.json, json!({ "op": "hello" }));
            assert!(read_frame(&mut input).unwrap().is_none());
        }
    }

    #[test]
    fn rejects_invalid_lengths_and_truncated_bodies() {
        for length in [HEADER_SIZE - 1, MAX_FRAME + 1] {
            let prefix = (length as u32).to_be_bytes();
            let error = read_frame(&mut prefix.as_slice()).err().unwrap();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        }
        let mut wire = (HEADER_SIZE as u32).to_be_bytes().to_vec();
        wire.push(REQUEST);
        wire.extend_from_slice(&1u32.to_be_bytes());
        wire.extend_from_slice(&1u32.to_be_bytes());
        let error = read_frame(&mut wire.as_slice()).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        wire.pop();
        let error = read_frame(&mut wire.as_slice()).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }
}
