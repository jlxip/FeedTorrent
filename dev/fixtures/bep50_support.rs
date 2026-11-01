use feedtorrent_bep::{bep44::*, bep50::*};
use feedtorrent_pubsub_udp::UdpPubSub;
use serde_json::{json, Value};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn unhex(s: &str) -> Result<Vec<u8>> {
    if !s.is_ascii() || !s.len().is_multiple_of(2) {
        return Err("Invalid hex".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&s[i..i + 2], 16)?))
        .collect()
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}
fn bytes(q: &Value, name: &str) -> Result<Vec<u8>> {
    unhex(q[name].as_str().unwrap_or(""))
}
fn key(q: &Value) -> Result<MutableKey> {
    Ok(MutableKey::new(
        bytes(q, "key")?
            .try_into()
            .map_err(|_| "Invalid public key")?,
        bytes(q, "salt")?,
    )?)
}
fn record(q: &Value) -> Result<MutableRecord> {
    Ok(MutableRecord::verify(
        key(q)?,
        q["sequence"].as_str().unwrap_or("0").parse()?,
        BencodedValue::parse(&bytes(q, "value")?)?,
        bytes(q, "signature")?
            .try_into()
            .map_err(|_| "Invalid signature")?,
    )?)
}
fn record_json(r: &MutableRecord) -> Value {
    json!({"key":hex(&r.key().public_key()),"salt":hex(r.key().salt()),"sequence":r.sequence().to_string(),"signature":hex(&r.signature()),"value":hex(r.value().as_bytes())})
}
pub fn run(driver: &mut UdpPubSub, q: &Value) -> Result<Value> {
    let now = driver.now();
    match q["op"].as_str().unwrap_or(""){
  "pubsub_info"=>Ok(json!({"port":driver.port(),"pending":driver.protocol().pending_count(),"contacts":driver.protocol().topics().iter().flat_map(|t|driver.protocol().contacts(*t)).map(|(id,addr)|json!({"id":hex(&id),"address":addr.to_string()})).collect::<Vec<_>>()})),
  "subscribe"=>{driver.protocol_mut().subscribe(key(q)?,q.get("known").map(record).transpose()?,now)?;Ok(json!(true))},
  "unsubscribe"=>{driver.protocol_mut().unsubscribe(key(q)?.target());Ok(json!(true))},
  "publish"=>{driver.protocol_mut().publish(record(q)?,now)?;Ok(json!(true))},
  "hint"=>{driver.protocol_mut().discovered(PeerHints{topic:key(q)?.target(),peers:q["peers"].as_array().ok_or("Missing peers")?.iter().map(|p|Ok(p.as_str().ok_or("Invalid peer")?.parse()?)).collect::<Result<_>>()?},now);Ok(json!(true))},
  "latest"=>Ok(json!(driver.protocol().latest(key(q)?.target()).map(record_json))),
  "pubsub_events"=>Ok(json!(driver.protocol_mut().drain_events().into_iter().map(|e|match e{Event::Updated{topic,record}=>json!({"type":"updated","topic":hex(&topic),"record":record_json(&record)}),Event::Acknowledged{topic,peer,sequence}=>json!({"type":"ack","topic":hex(&topic),"peer":peer.to_string(),"sequence":sequence.to_string()}),Event::Failure{topic,peer,error}=>json!({"type":"error","topic":hex(&topic),"peer":peer.map(|p|p.to_string()),"error":error.to_string()})}).collect::<Vec<_>>())),
  "pubsub_close"=>{driver.close();Ok(json!(true))},
  _=>Err("Unknown PubSub fixture command".into()),
 }
}
