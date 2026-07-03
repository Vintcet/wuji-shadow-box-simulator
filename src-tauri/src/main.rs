#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use chrono::{DateTime, Duration, Local, NaiveDate, TimeZone, Utc};
use futures_util::StreamExt;
use rand::Rng;
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const LOOT_POOLS_JSON: &str = include_str!("../../src/data/loot-pools.json");
const SALE_FEE_RATE: f64 = 0.05;
const PRICE_REFRESH_CONCURRENCY: usize = 16;
const PRICE_REFRESH_COOLDOWN_MS: u128 = 5000;
const PRICE_LOOKBACK_DAYS: i64 = 30;
const PRICE_LOG_LIMIT: u32 = 60;
const SIMULATION_MAX_COUNT: i64 = 999;
const JX3BOX_ITEM_DB_BASE_DATE: &str = "2026-06-29";

struct AppState {
    last_price_refresh_started_at: Mutex<u128>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerGroup {
    zone_name: String,
    servers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LootItem {
    box_name: String,
    school: String,
    short_name: String,
    item_name: String,
    item_id: Option<String>,
    icon_id: Option<i64>,
    jx3box_name: Option<String>,
    missing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BoxOption {
    name: String,
    item_count: usize,
    item_id: Option<String>,
    missing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppData {
    boxes: Vec<BoxOption>,
    server_groups: Vec<ServerGroup>,
    source_path: String,
    loaded_at: String,
    price_cache_path: String,
    price_cache_updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceSnapshot {
    item_id: Option<String>,
    item_name: String,
    server: String,
    icon_url: Option<String>,
    lowest_price: Option<i64>,
    date: Option<String>,
    updated_at: Option<String>,
    fetched_at: Option<String>,
    sample_size: Option<i64>,
    source: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimulationRequest {
    server: String,
    box_name: String,
    count: i64,
    missing_price_mode: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceRefreshRequest {
    server: String,
    box_name: String,
    scope: Option<String>,
    request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PriceRefreshResult {
    server: String,
    box_name: String,
    updated_at: String,
    cache_path: String,
    total: usize,
    success: usize,
    failed: usize,
    skipped: usize,
    snapshots: Vec<PriceSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PriceRefreshProgress {
    request_id: String,
    completed: usize,
    total: usize,
    success: usize,
    failed: usize,
    skipped: usize,
    server: Option<String>,
    item_name: Option<String>,
    done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DrawResult {
    index: usize,
    item_name: String,
    school: String,
    icon_url: Option<String>,
    price: Option<i64>,
    net_price: Option<i64>,
    price_label: Option<String>,
    missing_price: bool,
    date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AggregatedResult {
    item_name: String,
    school: String,
    icon_url: Option<String>,
    count: usize,
    unit_price: Option<i64>,
    unit_net_price: Option<i64>,
    subtotal: Option<i64>,
    date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SimulationResult {
    box_name: String,
    server: String,
    count: i64,
    data_dates: Vec<String>,
    price_basis: String,
    box_price: PriceSnapshot,
    box_unit_cost: Option<i64>,
    total_cost: Option<i64>,
    gross_value: i64,
    sale_fee: i64,
    sale_fee_rate: f64,
    total_value: i64,
    profit: Option<i64>,
    roi: Option<f64>,
    missing_price_count: usize,
    missing_items: Vec<String>,
    items: Vec<AggregatedResult>,
    draws: Vec<DrawResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLootItem {
    school: String,
    short_name: String,
    item_name: String,
    item_id: Option<String>,
    icon_id: Option<i64>,
    jx3box_name: Option<String>,
    missing: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBox {
    name: String,
    item_id: Option<String>,
    icon_id: Option<i64>,
    jx3box_name: Option<String>,
    missing: Option<bool>,
    items: Vec<RawLootItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLootPools {
    version: Option<u32>,
    enriched_at: Option<String>,
    boxes: Vec<RawBox>,
}

#[derive(Debug, Clone)]
struct PriceItemRef {
    item_name: String,
    item_id: Option<String>,
    icon_id: Option<i64>,
    jx3box_name: Option<String>,
}

#[derive(Debug, Clone)]
struct LootDataset {
    source_path: String,
    loaded_at: String,
    boxes: Vec<BoxOption>,
    loot_by_box: HashMap<String, Vec<LootItem>>,
    box_refs: HashMap<String, PriceItemRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PriceCacheFile {
    version: u32,
    updated_at: Option<String>,
    prices: HashMap<String, PriceSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemLookup {
    item_id: Option<String>,
    icon_id: Option<i64>,
    jx3box_name: Option<String>,
    missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LootPoolOverrides {
    version: u32,
    updated_at: Option<String>,
    checked_item_db_time: Option<String>,
    items: HashMap<String, ItemLookup>,
}

#[derive(Debug, Deserialize)]
struct Jx3boxItemSearchResponse {
    data: Option<Jx3boxItemSearchData>,
}

#[derive(Debug, Deserialize)]
struct Jx3boxItemSearchData {
    data: Option<Vec<Jx3boxItemSearchItem>>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(non_snake_case)]
struct Jx3boxItemSearchItem {
    id: Option<String>,
    Name: Option<String>,
    IconID: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct Jx3boxDatabaseStat {
    version: Option<Vec<Jx3boxDatabaseVersion>>,
}

#[derive(Debug, Deserialize)]
struct Jx3boxDatabaseVersion {
    name: Option<String>,
    time: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PriceLog {
    #[serde(rename = "LowestPrice")]
    lowest_price: Option<i64>,
    #[serde(rename = "Date")]
    date: Option<String>,
    #[serde(rename = "UpdatedAt")]
    updated_at: Option<String>,
    #[serde(rename = "SampleSize")]
    sample_size: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ItemPriceData {
    logs: Option<Vec<PriceLog>>,
    today: Option<PriceLog>,
    yesterday: Option<PriceLog>,
}

#[derive(Debug, Deserialize)]
struct ItemPriceResponse {
    data: Option<ItemPriceData>,
}

#[derive(Debug, Clone)]
struct PriceTask {
    server: String,
    item_ref: PriceItemRef,
}

#[derive(Debug, Clone)]
struct PriceTaskResult {
    server: String,
    item_ref: PriceItemRef,
    snapshot: PriceSnapshot,
}

fn server_groups() -> Vec<ServerGroup> {
    vec![
        ServerGroup {
            zone_name: "电信区".to_string(),
            servers: vec![
                "梦江南", "唯我独尊", "乾坤一掷", "斗转星移", "幽月轮", "剑胆琴心", "长安城", "蝶恋花", "龙争虎斗", "绝代天骄",
            ]
            .into_iter()
            .map(String::from)
            .collect(),
        },
        ServerGroup {
            zone_name: "双线区".to_string(),
            servers: vec!["破阵子", "天鹅坪", "飞龙在天"]
                .into_iter()
                .map(String::from)
                .collect(),
        },
        ServerGroup {
            zone_name: "无界区".to_string(),
            servers: vec!["山海相逢", "眉间雪"]
                .into_iter()
                .map(String::from)
                .collect(),
        },
    ]
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn iso_now() -> String {
    Utc::now().to_rfc3339()
}

fn raw_loot_pools() -> Result<RawLootPools, String> {
    serde_json::from_str(LOOT_POOLS_JSON).map_err(|error| format!("读取掉落池数据失败：{error}"))
}

fn loot_overrides_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("loot-pools-overrides.json"))
        .map_err(|error| format!("获取数据补全目录失败：{error}"))
}

fn load_loot_overrides(app: &AppHandle) -> Result<LootPoolOverrides, String> {
    let path = loot_overrides_path(app)?;
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).map_err(|error| format!("读取数据补全缓存失败：{error}")),
        Err(_) => Ok(LootPoolOverrides {
            version: 1,
            updated_at: None,
            checked_item_db_time: None,
            items: HashMap::new(),
        }),
    }
}

fn save_loot_overrides(app: &AppHandle, overrides: &LootPoolOverrides) -> Result<(), String> {
    let path = loot_overrides_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建数据补全目录失败：{error}"))?;
    }
    let content = serde_json::to_string_pretty(overrides).map_err(|error| format!("序列化数据补全缓存失败：{error}"))?;
    fs::write(path, format!("{content}\n")).map_err(|error| format!("写入数据补全缓存失败：{error}"))
}

fn apply_lookup_to_box(box_item: &mut RawBox, lookup: &ItemLookup) {
    if box_item.item_id.is_none() {
        box_item.item_id = lookup.item_id.clone();
    }
    if box_item.icon_id.is_none() {
        box_item.icon_id = lookup.icon_id;
    }
    if box_item.jx3box_name.is_none() {
        box_item.jx3box_name = lookup.jx3box_name.clone();
    }
    if lookup.item_id.is_some() {
        box_item.missing = Some(false);
    }
}

fn apply_lookup_to_item(item: &mut RawLootItem, lookup: &ItemLookup) {
    if item.item_id.is_none() {
        item.item_id = lookup.item_id.clone();
    }
    if item.icon_id.is_none() {
        item.icon_id = lookup.icon_id;
    }
    if item.jx3box_name.is_none() {
        item.jx3box_name = lookup.jx3box_name.clone();
    }
    if lookup.item_id.is_some() {
        item.missing = Some(false);
    }
}

fn apply_loot_overrides(raw: &mut RawLootPools, overrides: &LootPoolOverrides) {
    for box_item in &mut raw.boxes {
        if let Some(lookup) = overrides.items.get(&box_item.name) {
            apply_lookup_to_box(box_item, lookup);
        }
        for item in &mut box_item.items {
            if let Some(lookup) = overrides.items.get(&item.item_name) {
                apply_lookup_to_item(item, lookup);
            }
        }
    }
}

fn load_loot_dataset(app: &AppHandle) -> Result<LootDataset, String> {
    let mut raw = raw_loot_pools()?;
    let overrides = load_loot_overrides(app)?;
    apply_loot_overrides(&mut raw, &overrides);
    let mut loot_by_box = HashMap::new();
    let mut box_refs = HashMap::new();

    for box_item in &raw.boxes {
        box_refs.insert(
            box_item.name.clone(),
            PriceItemRef {
                item_name: box_item.name.clone(),
                item_id: box_item.item_id.clone(),
                icon_id: box_item.icon_id,
                jx3box_name: box_item.jx3box_name.clone(),
            },
        );

        let loot_items = box_item
            .items
            .iter()
            .map(|item| LootItem {
                box_name: box_item.name.clone(),
                school: item.school.clone(),
                short_name: item.short_name.clone(),
                item_name: item.item_name.clone(),
                item_id: item.item_id.clone(),
                icon_id: item.icon_id,
                jx3box_name: item.jx3box_name.clone(),
                missing: item.missing,
            })
            .collect::<Vec<_>>();

        loot_by_box.insert(box_item.name.clone(), loot_items);
    }

    let boxes = raw
        .boxes
        .iter()
        .map(|box_item| BoxOption {
            name: box_item.name.clone(),
            item_count: box_item.items.len(),
            item_id: box_item.item_id.clone(),
            missing: box_item.missing,
        })
        .collect();

    Ok(LootDataset {
        source_path: "src/data/loot-pools.json".to_string(),
        loaded_at: raw.enriched_at.unwrap_or_else(iso_now),
        boxes,
        loot_by_box,
        box_refs,
    })
}

fn normalize_name(name: &str) -> String {
    name.split_whitespace().collect::<String>()
}

fn local_date_key_from_date(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn local_date_key(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.is_empty() {
        return None;
    }

    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(local_date_key_from_date(date));
    }

    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| local_date_key_from_date(date.with_timezone(&Local).date_naive()))
}

fn parse_price_date(value: Option<&str>) -> Option<NaiveDate> {
    let value = value?;
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        return Some(date);
    }

    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.with_timezone(&Local).date_naive())
}

fn is_within_price_lookback(value: Option<&str>) -> bool {
    let Some(date) = parse_price_date(value) else {
        return false;
    };

    let earliest = Local::now().date_naive() - Duration::days(PRICE_LOOKBACK_DAYS - 1);
    date >= earliest
}

fn was_price_updated_today(snapshot: Option<&PriceSnapshot>, today_key: &str) -> bool {
    snapshot
        .and_then(|snapshot| {
            if snapshot.lowest_price.is_some() {
                local_date_key(snapshot.fetched_at.as_deref())
            } else {
                None
            }
        })
        .is_some_and(|date| date == today_key)
}

fn price_date_from_auction_timestamp(value: &Value) -> Option<String> {
    let numeric = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse::<f64>().ok(),
        _ => None,
    }?;

    if !numeric.is_finite() {
        return None;
    }

    let millis = if numeric < 10_000_000_000.0 {
        (numeric * 1000.0) as i64
    } else {
        numeric as i64
    };
    let seconds = millis.div_euclid(1000);
    let nanos = (millis.rem_euclid(1000) as u32) * 1_000_000;

    Utc.timestamp_opt(seconds, nanos)
        .single()
        .map(|date| local_date_key_from_date(date.with_timezone(&Local).date_naive()))
}

fn icon_url_from_icon_id(icon_id: Option<i64>) -> Option<String> {
    icon_id.map(|id| format!("https://icon.jx3box.com/icon/{id}.png"))
}

fn snapshot_without_price(
    item_ref: &PriceItemRef,
    server: &str,
    error: impl Into<String>,
    fetched_at: Option<String>,
) -> PriceSnapshot {
    PriceSnapshot {
        item_id: item_ref.item_id.clone(),
        item_name: item_ref
            .jx3box_name
            .clone()
            .unwrap_or_else(|| item_ref.item_name.clone()),
        server: server.to_string(),
        icon_url: icon_url_from_icon_id(item_ref.icon_id),
        lowest_price: None,
        date: None,
        updated_at: None,
        fetched_at,
        sample_size: None,
        source: "none".to_string(),
        error: Some(error.into()),
    }
}

fn cache_key(server: &str, item_ref: &PriceItemRef) -> String {
    format!(
        "{server}::{}",
        item_ref
            .item_id
            .clone()
            .unwrap_or_else(|| format!("name:{}", item_ref.item_name))
    )
}

fn price_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("price-cache.json"))
        .map_err(|error| format!("获取缓存目录失败：{error}"))
}

fn load_price_cache(app: &AppHandle) -> Result<PriceCacheFile, String> {
    let path = price_cache_path(app)?;
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).map_err(|error| format!("读取价格缓存失败：{error}")),
        Err(_) => Ok(PriceCacheFile {
            version: 1,
            updated_at: None,
            prices: HashMap::new(),
        }),
    }
}

fn save_price_cache(app: &AppHandle, cache: &PriceCacheFile) -> Result<(), String> {
    let path = price_cache_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建缓存目录失败：{error}"))?;
    }
    let content = serde_json::to_string_pretty(cache).map_err(|error| format!("序列化价格缓存失败：{error}"))?;
    fs::write(path, format!("{content}\n")).map_err(|error| format!("写入价格缓存失败：{error}"))
}

fn log_path() -> PathBuf {
    let date = local_date_key_from_date(Local::now().date_naive());
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join("log").join(format!("{date}.log"))))
        .unwrap_or_else(|| PathBuf::from("log").join(format!("{date}.log")))
}

fn write_app_log(event: &str, details: Value) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let mut entry = serde_json::Map::new();
    entry.insert("time".to_string(), Value::String(iso_now()));
    entry.insert("event".to_string(), Value::String(event.to_string()));
    if let Value::Object(details) = details {
        for (key, value) in details {
            entry.insert(key, value);
        }
    }

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", Value::Object(entry));
    }
}

async fn fetch_json<T: DeserializeOwned>(client: &Client, url: &str) -> Result<T, String> {
    let response = client
        .get(url)
        .header("accept", "application/json,text/plain,*/*")
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    response.json::<T>().await.map_err(|error| error.to_string())
}

async fn search_jx3box_item(client: &Client, item_name: &str) -> Result<ItemLookup, String> {
    let url = format!(
        "https://node.jx3box.com/api/node/item/search?ids=&keyword={}&client=std&per=35",
        urlencoding::encode(item_name)
    );
    let payload: Jx3boxItemSearchResponse = fetch_json(client, &url).await?;
    let items = payload.data.and_then(|data| data.data).unwrap_or_default();
    let wanted = normalize_name(item_name);

    let selected = items
        .iter()
        .find(|candidate| candidate.Name.as_deref() == Some(item_name))
        .or_else(|| {
            items
                .iter()
                .find(|candidate| candidate.Name.as_deref().is_some_and(|name| normalize_name(name) == wanted))
        })
        .or_else(|| {
            items
                .iter()
                .find(|candidate| candidate.Name.as_deref().is_some_and(|name| normalize_name(name).contains(&wanted)))
        });

    Ok(selected
        .and_then(|item| {
            item.id.as_ref().map(|item_id| ItemLookup {
                item_id: Some(item_id.clone()),
                icon_id: item.IconID,
                jx3box_name: item.Name.clone(),
                missing: false,
            })
        })
        .unwrap_or(ItemLookup {
            item_id: None,
            icon_id: None,
            jx3box_name: None,
            missing: true,
        }))
}

fn date_part(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.len() >= 10 {
        Some(&value[..10])
    } else {
        None
    }
}

fn is_jx3box_item_db_newer(time: &str) -> bool {
    date_part(time).is_some_and(|date| date > JX3BOX_ITEM_DB_BASE_DATE)
}

async fn fetch_jx3box_item_db_time(client: &Client) -> Result<Option<String>, String> {
    let payload: Jx3boxDatabaseStat = fetch_json(client, "https://node.jx3box.com/?client=std").await?;
    Ok(payload
        .version
        .unwrap_or_default()
        .into_iter()
        .find(|version| version.name.as_deref() == Some("item"))
        .and_then(|version| version.time))
}

async fn enrich_missing_loot_data(app: &AppHandle, client: &Client) -> Result<usize, String> {
    let mut raw = raw_loot_pools()?;
    let mut overrides = load_loot_overrides(app)?;
    apply_loot_overrides(&mut raw, &overrides);

    let item_db_time = fetch_jx3box_item_db_time(client).await?;
    let Some(item_db_time) = item_db_time else {
        write_app_log("loot_data_enrich_skipped_no_db_version", serde_json::json!({}));
        return Ok(0);
    };

    if !is_jx3box_item_db_newer(&item_db_time) {
        write_app_log(
            "loot_data_enrich_skipped_db_not_newer",
            serde_json::json!({
                "itemDbTime": item_db_time,
                "baseDate": JX3BOX_ITEM_DB_BASE_DATE
            }),
        );
        return Ok(0);
    }

    if overrides.checked_item_db_time.as_deref() == Some(item_db_time.as_str()) {
        write_app_log(
            "loot_data_enrich_skipped_db_already_checked",
            serde_json::json!({
                "itemDbTime": item_db_time
            }),
        );
        return Ok(0);
    }

    let mut names = Vec::new();
    let mut seen = HashSet::new();
    for box_item in &raw.boxes {
        if box_item.item_id.is_none() && seen.insert(box_item.name.clone()) {
            names.push(box_item.name.clone());
        }
        for item in &box_item.items {
            if item.item_id.is_none() && seen.insert(item.item_name.clone()) {
                names.push(item.item_name.clone());
            }
        }
    }

    if names.is_empty() {
        overrides.checked_item_db_time = Some(item_db_time);
        save_loot_overrides(app, &overrides)?;
        return Ok(0);
    }

    let mut resolved = 0;
    for name in names {
        match search_jx3box_item(client, &name).await {
            Ok(lookup) => {
                if lookup.item_id.is_some() {
                    resolved += 1;
                    overrides.items.insert(name, lookup);
                }
            }
            Err(error) => {
                write_app_log(
                    "loot_data_enrich_item_failed",
                    serde_json::json!({
                        "itemName": name,
                        "error": error
                    }),
                );
            }
        }
    }

    overrides.checked_item_db_time = Some(item_db_time.clone());
    if resolved > 0 {
        overrides.updated_at = Some(iso_now());
    }
    save_loot_overrides(app, &overrides)?;
    write_app_log(
        "loot_data_enriched",
        serde_json::json!({
            "resolved": resolved,
            "itemDbTime": item_db_time,
            "overridePath": loot_overrides_path(app).map(|path| path.display().to_string()).unwrap_or_default()
        }),
    );

    Ok(resolved)
}

async fn post_json_value(client: &Client, url: &str, payload: Value) -> Result<Value, String> {
    let response = client
        .post(url)
        .header("accept", "application/json,text/plain,*/*")
        .json(&payload)
        .send()
        .await
        .map_err(|error| error.to_string())?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }

    response.json::<Value>().await.map_err(|error| error.to_string())
}

fn usable_price_log(log: Option<&PriceLog>) -> Option<PriceLog> {
    let log = log?;
    if log.lowest_price.is_some() && log.date.as_deref().is_some_and(|date| is_within_price_lookback(Some(date))) {
        Some(log.clone())
    } else {
        None
    }
}

async fn query_price_from_auction_history(client: &Client, item_ref: &PriceItemRef, server: &str, fetched_at: &str) -> Result<Option<PriceSnapshot>, String> {
    let Some(item_id) = item_ref.item_id.as_deref() else {
        return Ok(None);
    };

    let payload = serde_json::json!({
        "server": server,
        "item_id": item_id,
        "aggregate_type": "daily"
    });
    let response = post_json_value(client, "https://next2.jx3box.com/api/auction/", payload).await?;
    let rows = response
        .as_array()
        .cloned()
        .or_else(|| response.get("data").and_then(Value::as_array).cloned())
        .unwrap_or_default();

    let selected = rows
        .into_iter()
        .filter_map(|row| {
            let price = row.get("price").and_then(|value| value.as_i64().or_else(|| value.as_f64().map(|price| price as i64)))?;
            let date = row.get("timestamp").and_then(price_date_from_auction_timestamp)?;
            if is_within_price_lookback(Some(&date)) {
                Some((date, price))
            } else {
                None
            }
        })
        .max_by(|left, right| left.0.cmp(&right.0));

    Ok(selected.map(|(date, price)| PriceSnapshot {
        item_id: item_ref.item_id.clone(),
        item_name: item_ref
            .jx3box_name
            .clone()
            .unwrap_or_else(|| item_ref.item_name.clone()),
        server: server.to_string(),
        icon_url: icon_url_from_icon_id(item_ref.icon_id),
        lowest_price: Some(price),
        date: Some(date),
        updated_at: None,
        fetched_at: Some(fetched_at.to_string()),
        sample_size: None,
        source: "auction".to_string(),
        error: None,
    }))
}

async fn query_price_from_api(client: &Client, item_ref: &PriceItemRef, server: &str) -> PriceSnapshot {
    let fetched_at = iso_now();

    let Some(item_id) = item_ref.item_id.as_deref() else {
        return snapshot_without_price(item_ref, server, "静态表中没有 JX3BOX 物品 ID，无法更新价格", Some(fetched_at));
    };

    let result = async {
        let url = format!(
            "https://next2.jx3box.com/api/item-price/{}/logs?server={}&limit={PRICE_LOG_LIMIT}",
            urlencoding::encode(item_id),
            urlencoding::encode(server)
        );
        let payload: ItemPriceResponse = fetch_json(client, &url).await?;
        let data = payload.data;

        let selected = usable_price_log(data.as_ref().and_then(|data| data.today.as_ref()))
            .map(|log| (log, "today"))
            .or_else(|| usable_price_log(data.as_ref().and_then(|data| data.yesterday.as_ref())).map(|log| (log, "yesterday")))
            .or_else(|| {
                data.as_ref()
                    .and_then(|data| data.logs.as_ref())
                    .and_then(|logs| {
                        logs.iter()
                            .filter_map(|log| usable_price_log(Some(log)))
                            .max_by(|left, right| left.date.cmp(&right.date))
                    })
                    .map(|log| (log, "history"))
            });

        if let Some((log, source)) = selected {
            return Ok(PriceSnapshot {
                item_id: item_ref.item_id.clone(),
                item_name: item_ref
                    .jx3box_name
                    .clone()
                    .unwrap_or_else(|| item_ref.item_name.clone()),
                server: server.to_string(),
                icon_url: icon_url_from_icon_id(item_ref.icon_id),
                lowest_price: log.lowest_price,
                date: log.date,
                updated_at: log.updated_at,
                fetched_at: Some(fetched_at.clone()),
                sample_size: log.sample_size,
                source: source.to_string(),
                error: None,
            });
        }

        if let Some(snapshot) = query_price_from_auction_history(client, item_ref, server, &fetched_at).await? {
            return Ok(snapshot);
        }

        Ok(snapshot_without_price(
            item_ref,
            server,
            format!("最近{PRICE_LOOKBACK_DAYS}天没有可用最低价数据"),
            Some(fetched_at.clone()),
        ))
    }
    .await;

    result.unwrap_or_else(|error: String| snapshot_without_price(item_ref, server, error, Some(fetched_at)))
}

fn unique_refs(refs: Vec<PriceItemRef>) -> Vec<PriceItemRef> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();

    for item_ref in refs {
        let key = item_ref.item_id.clone().unwrap_or_else(|| normalize_name(&item_ref.item_name));
        if seen.insert(key) {
            result.push(item_ref);
        }
    }

    result
}

fn get_refs_for_box(dataset: &LootDataset, box_name: &str) -> Result<Vec<PriceItemRef>, String> {
    let box_ref = dataset
        .box_refs
        .get(box_name)
        .ok_or_else(|| format!("找不到箱子池子：{box_name}"))?;
    let loot_pool = dataset
        .loot_by_box
        .get(box_name)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| format!("找不到箱子池子：{box_name}"))?;

    let mut refs = vec![box_ref.clone()];
    refs.extend(loot_pool.iter().map(|item| PriceItemRef {
        item_name: item.item_name.clone(),
        item_id: item.item_id.clone(),
        icon_id: item.icon_id,
        jx3box_name: item.jx3box_name.clone(),
    }));

    Ok(unique_refs(refs))
}

fn get_all_servers() -> Vec<String> {
    server_groups()
        .into_iter()
        .flat_map(|group| group.servers)
        .collect()
}

fn get_refs_for_all_boxes(dataset: &LootDataset) -> Vec<PriceItemRef> {
    let mut refs = Vec::new();

    for box_item in &dataset.boxes {
        if let Some(box_ref) = dataset.box_refs.get(&box_item.name) {
            refs.push(box_ref.clone());
        }

        if let Some(loot_pool) = dataset.loot_by_box.get(&box_item.name) {
            refs.extend(loot_pool.iter().map(|item| PriceItemRef {
                item_name: item.item_name.clone(),
                item_id: item.item_id.clone(),
                icon_id: item.icon_id,
                jx3box_name: item.jx3box_name.clone(),
            }));
        }
    }

    unique_refs(refs)
}

fn emit_price_refresh_progress(app: &AppHandle, progress: PriceRefreshProgress) {
    let _ = app.emit("app:refresh-prices-progress", progress);
}

fn apply_sale_fee(price: Option<i64>) -> Option<i64> {
    price.map(|price| price * 95 / 100)
}

async fn get_cached_price(app: &AppHandle, item_ref: &PriceItemRef, server: &str) -> Result<PriceSnapshot, String> {
    if item_ref.item_id.is_none() {
        return Ok(snapshot_without_price(item_ref, server, "静态表中没有 JX3BOX 物品 ID", None));
    }

    let cache = load_price_cache(app)?;
    Ok(cache
        .prices
        .get(&cache_key(server, item_ref))
        .cloned()
        .unwrap_or_else(|| snapshot_without_price(item_ref, server, "本地没有价格缓存，请先点击“更新价格数据”", None)))
}

#[tauri::command]
async fn get_data(app: AppHandle) -> Result<AppData, String> {
    let dataset = load_loot_dataset(&app)?;
    let price_cache = load_price_cache(&app)?;
    Ok(AppData {
        boxes: dataset.boxes,
        server_groups: server_groups(),
        source_path: dataset.source_path,
        loaded_at: dataset.loaded_at,
        price_cache_path: price_cache_path(&app)?.display().to_string(),
        price_cache_updated_at: price_cache.updated_at,
    })
}

#[tauri::command]
async fn refresh_prices(app: AppHandle, state: tauri::State<'_, AppState>, request: PriceRefreshRequest) -> Result<PriceRefreshResult, String> {
    let request_id = request.request_id.clone().unwrap_or_else(|| now_millis().to_string());
    let now = now_millis();
    {
        let mut last_started_at = state
            .last_price_refresh_started_at
            .lock()
            .map_err(|_| "价格刷新状态锁定失败".to_string())?;
        let cooldown_remaining = PRICE_REFRESH_COOLDOWN_MS.saturating_sub(now.saturating_sub(*last_started_at));
        if cooldown_remaining > 0 {
            write_app_log(
                "price_refresh_blocked_cooldown",
                serde_json::json!({
                    "requestId": request_id,
                    "scope": request.scope.clone().unwrap_or_else(|| "selected".to_string()),
                    "server": request.server,
                    "boxName": request.box_name,
                    "cooldownRemainingMs": cooldown_remaining
                }),
            );
            return Err(format!("更新价格太频繁，请 {} 秒后再试。", (cooldown_remaining + 999) / 1000));
        }
        *last_started_at = now;
    }

    let started_at = now_millis();
    let result = async {
        let refresh_all = request.scope.as_deref() == Some("all");
        let client = Client::builder()
            .user_agent("wuji-shadow-box-simulator/0.1.0")
            .build()
            .map_err(|error| error.to_string())?;

        if refresh_all {
            let resolved = enrich_missing_loot_data(&app, &client).await?;
            if resolved > 0 {
                write_app_log(
                    "price_refresh_loot_data_enriched",
                    serde_json::json!({
                        "requestId": request_id,
                        "resolved": resolved
                    }),
                );
            }
        }

        let dataset = load_loot_dataset(&app)?;
        let refs = if refresh_all {
            get_refs_for_all_boxes(&dataset)
        } else {
            get_refs_for_box(&dataset, &request.box_name)?
        };
        let servers = if refresh_all {
            get_all_servers()
        } else {
            vec![request.server.clone()]
        };
        let all_tasks = servers
            .into_iter()
            .flat_map(|server| {
                refs.iter().cloned().map(move |item_ref| PriceTask {
                    server: server.clone(),
                    item_ref,
                })
            })
            .collect::<Vec<_>>();

        let mut cache = load_price_cache(&app)?;
        let today_key = local_date_key_from_date(Local::now().date_naive());
        let mut skipped = 0;
        let mut skipped_snapshots = Vec::new();
        let mut tasks = Vec::new();

        for task in all_tasks {
            let key = cache_key(&task.server, &task.item_ref);
            if let Some(snapshot) = cache.prices.get(&key).filter(|snapshot| was_price_updated_today(Some(snapshot), &today_key)) {
                skipped += 1;
                skipped_snapshots.push(snapshot.clone());
            } else {
                tasks.push(task);
            }
        }

        let total = tasks.len();
        let mut completed = 0;
        let mut success = 0;
        let mut failed = 0;

        emit_price_refresh_progress(
            &app,
            PriceRefreshProgress {
                request_id: request_id.clone(),
                completed,
                total,
                success,
                failed,
                skipped,
                server: None,
                item_name: None,
                done: total == 0,
            },
        );

        let mut stream = futures_util::stream::iter(tasks.into_iter().map(|task| {
            let client = client.clone();
            async move {
                let snapshot = query_price_from_api(&client, &task.item_ref, &task.server).await;
                PriceTaskResult {
                    server: task.server,
                    item_ref: task.item_ref,
                    snapshot,
                }
            }
        }))
        .buffer_unordered(PRICE_REFRESH_CONCURRENCY);

        let mut results = Vec::new();
        while let Some(result) = stream.next().await {
            completed += 1;
            if result.snapshot.lowest_price.is_some() {
                success += 1;
            } else {
                failed += 1;
            }

            emit_price_refresh_progress(
                &app,
                PriceRefreshProgress {
                    request_id: request_id.clone(),
                    completed,
                    total,
                    success,
                    failed,
                    skipped,
                    server: Some(result.server.clone()),
                    item_name: Some(
                        result
                            .item_ref
                            .jx3box_name
                            .clone()
                            .unwrap_or_else(|| result.item_ref.item_name.clone()),
                    ),
                    done: completed == total,
                },
            );

            results.push(result);
        }

        let updated_at = iso_now();
        for result in &results {
            cache.prices.insert(cache_key(&result.server, &result.item_ref), result.snapshot.clone());
        }

        if !results.is_empty() {
            cache.updated_at = Some(updated_at.clone());
            save_price_cache(&app, &cache)?;
        }

        for result in results.iter().filter(|result| result.snapshot.lowest_price.is_none()) {
            write_app_log(
                "price_refresh_item",
                serde_json::json!({
                    "requestId": request_id,
                    "status": "failed",
                    "server": result.server,
                    "itemId": result.item_ref.item_id,
                    "itemName": result.item_ref.jx3box_name.clone().unwrap_or_else(|| result.item_ref.item_name.clone()),
                    "lowestPrice": result.snapshot.lowest_price,
                    "priceDate": result.snapshot.date,
                    "source": result.snapshot.source,
                    "fetchedAt": result.snapshot.fetched_at,
                    "error": result.snapshot.error.clone().unwrap_or_else(|| "unknown".to_string())
                }),
            );
        }

        let mut snapshots = skipped_snapshots;
        snapshots.extend(results.into_iter().map(|result| result.snapshot));

        Ok(PriceRefreshResult {
            server: if refresh_all { "全部区服".to_string() } else { request.server.clone() },
            box_name: if refresh_all { "全部图".to_string() } else { request.box_name.clone() },
            updated_at: cache.updated_at.clone().unwrap_or(updated_at),
            cache_path: price_cache_path(&app)?.display().to_string(),
            total,
            success,
            failed,
            skipped,
            snapshots,
        })
    }
    .await;

    if let Err(error) = &result {
        write_app_log(
            "price_refresh_failed",
            serde_json::json!({
                "requestId": request_id,
                "scope": request.scope.clone().unwrap_or_else(|| "selected".to_string()),
                "server": request.server,
                "boxName": request.box_name,
                "error": error,
                "elapsedMs": now_millis().saturating_sub(started_at)
            }),
        );
    }

    result
}

#[tauri::command]
async fn simulate(app: AppHandle, request: SimulationRequest) -> Result<SimulationResult, String> {
    let started_at = now_millis();
    let count = request.count.clamp(1, SIMULATION_MAX_COUNT);
    let result = async {
        let dataset = load_loot_dataset(&app)?;
        let loot_pool = dataset
            .loot_by_box
            .get(&request.box_name)
            .filter(|items| !items.is_empty())
            .ok_or_else(|| format!("找不到箱子池子：{}", request.box_name))?;
        let box_ref = dataset
            .box_refs
            .get(&request.box_name)
            .ok_or_else(|| format!("找不到箱子池子：{}", request.box_name))?;
        let refs = get_refs_for_box(&dataset, &request.box_name)?;
        let mut snapshot_by_key = HashMap::new();

        for item_ref in &refs {
            let snapshot = get_cached_price(&app, item_ref, &request.server).await?;
            snapshot_by_key.insert(item_ref.item_id.clone().unwrap_or_else(|| normalize_name(&item_ref.item_name)), snapshot);
        }

        let box_key = box_ref.item_id.clone().unwrap_or_else(|| normalize_name(&box_ref.item_name));
        let box_price = snapshot_by_key
            .get(&box_key)
            .cloned()
            .unwrap_or_else(|| snapshot_without_price(box_ref, &request.server, "本地没有价格缓存", None));
        let box_unit_cost = box_price.lowest_price;
        let use_box_cost_for_missing = request.missing_price_mode == "box-cost";

        let mut rng = rand::thread_rng();
        let draws = (0..count as usize)
            .map(|draw_index| {
                let item = &loot_pool[rng.gen_range(0..loot_pool.len())];
                let key = item.item_id.clone().unwrap_or_else(|| normalize_name(&item.item_name));
                let price = snapshot_by_key.get(&key);
                let lowest_price = price.and_then(|snapshot| snapshot.lowest_price);
                let (final_price, final_net_price, price_label, final_date, icon_url) = if lowest_price.is_some() {
                    (
                        lowest_price,
                        apply_sale_fee(lowest_price),
                        None,
                        price.and_then(|snapshot| snapshot.date.clone()),
                        price
                            .and_then(|snapshot| snapshot.icon_url.clone())
                            .or_else(|| icon_url_from_icon_id(item.icon_id)),
                    )
                } else if use_box_cost_for_missing {
                    (
                        box_unit_cost,
                        box_unit_cost,
                        Some("成本价".to_string()),
                        box_price.date.clone(),
                        box_price.icon_url.clone(),
                    )
                } else {
                    (
                        Some(0),
                        Some(0),
                        None,
                        None,
                        price
                            .and_then(|snapshot| snapshot.icon_url.clone())
                            .or_else(|| icon_url_from_icon_id(item.icon_id)),
                    )
                };

                DrawResult {
                    index: draw_index + 1,
                    item_name: item.item_name.clone(),
                    school: item.school.clone(),
                    icon_url,
                    price: final_price,
                    net_price: final_net_price,
                    price_label,
                    missing_price: lowest_price.is_none(),
                    date: final_date,
                }
            })
            .collect::<Vec<_>>();

        let mut aggregate: HashMap<String, AggregatedResult> = HashMap::new();
        for draw in &draws {
            let key = normalize_name(&draw.item_name);
            aggregate
                .entry(key)
                .and_modify(|item| item.count += 1)
                .or_insert_with(|| AggregatedResult {
                    item_name: draw.item_name.clone(),
                    school: draw.school.clone(),
                    icon_url: draw.icon_url.clone(),
                    count: 1,
                    unit_price: draw.price,
                    unit_net_price: draw.net_price,
                    subtotal: None,
                    date: draw.date.clone(),
                });
        }

        let mut items = aggregate
            .into_values()
            .map(|mut item| {
                item.subtotal = item.unit_net_price.map(|price| price * item.count as i64);
                item
            })
            .collect::<Vec<_>>();
        items.sort_by(|left, right| right.subtotal.unwrap_or(0).cmp(&left.subtotal.unwrap_or(0)));

        let gross_value = draws.iter().map(|item| item.price.unwrap_or(0)).sum::<i64>();
        let total_value = draws.iter().map(|item| item.net_price.unwrap_or(0)).sum::<i64>();
        let sale_fee = gross_value - total_value;
        let total_cost = box_unit_cost.map(|price| price * count);
        let profit = total_cost.map(|cost| total_value - cost);
        let roi = match (profit, total_cost) {
            (Some(profit), Some(cost)) if cost != 0 => Some(profit as f64 / cost as f64),
            _ => None,
        };
        let missing_items = draws
            .iter()
            .filter(|item| item.missing_price)
            .map(|item| item.item_name.clone())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut data_dates = HashSet::new();
        if let Some(date) = box_price.date.clone() {
            data_dates.insert(date);
        }
        for item in &items {
            if let Some(date) = item.date.clone() {
                data_dates.insert(date);
            }
        }
        let mut data_dates = data_dates.into_iter().collect::<Vec<_>>();
        data_dates.sort();

        Ok(SimulationResult {
            box_name: request.box_name.clone(),
            server: request.server.clone(),
            count,
            data_dates,
            price_basis: "lowest".to_string(),
            box_price,
            box_unit_cost,
            total_cost,
            gross_value,
            sale_fee,
            sale_fee_rate: SALE_FEE_RATE,
            total_value,
            profit,
            roi,
            missing_price_count: missing_items.len(),
            missing_items,
            items,
            draws,
        })
    }
    .await;

    if let Err(error) = &result {
        write_app_log(
            "simulation_failed",
            serde_json::json!({
                "server": request.server,
                "boxName": request.box_name,
                "count": count,
                "error": error,
                "elapsedMs": now_millis().saturating_sub(started_at)
            }),
        );
    }

    result
}

fn main() {
    tauri::Builder::default()
        .manage(AppState {
            last_price_refresh_started_at: Mutex::new(0),
        })
        .invoke_handler(tauri::generate_handler![get_data, refresh_prices, simulate])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
