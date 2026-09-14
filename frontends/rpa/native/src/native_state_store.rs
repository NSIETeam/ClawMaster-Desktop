use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sled::transaction::{ConflictableTransactionError, TransactionError, Transactional};
use sled::{Db, Tree};
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{SystemTime, UNIX_EPOCH};

const STORE_DIRECTORY: &str = "runtime-store-v1";
const KEYRING_SERVICE: &str = "team.nsi.clawmaster.runtime-store";
const CIPHERTEXT_VERSION: u8 = 1;
const NONCE_BYTES: usize = 12;
const SCHEMA_VERSION: u16 = 1;

pub const TREE_SESSIONS: &str = "session";
pub const TREE_EVENTS: &str = "event";
pub const TREE_MEMORY: &str = "memory";
pub const TREE_INDEX: &str = "index";
pub const TREE_ARTIFACT_METADATA: &str = "artifact_metadata";
pub const TREE_ARTIFACTS: &str = "artifact";
pub const TREE_CHECKPOINTS: &str = "checkpoint";
pub const TREE_USAGE: &str = "usage";
pub const TREE_TOMBSTONES: &str = "tombstone";

pub const REQUIRED_TREES: &[&str] = &[
    TREE_SESSIONS,
    TREE_EVENTS,
    TREE_MEMORY,
    TREE_INDEX,
    TREE_ARTIFACT_METADATA,
    TREE_ARTIFACTS,
    TREE_CHECKPOINTS,
    TREE_USAGE,
    TREE_TOMBSTONES,
];

static OPEN_STORES: OnceLock<Mutex<HashMap<PathBuf, Weak<StoreInner>>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateStoreError {
    InvalidPath,
    UnknownTree(String),
    Database(String),
    Credential(String),
    Crypto,
    Serialization(String),
    RevisionConflict { expected: u64, actual: u64 },
    IdempotencyConflict,
    CorruptRecord { tree: String, key_digest: String },
    ArtifactIntegrity,
}

impl fmt::Display for StateStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath => formatter.write_str("NativeStateStore 路径无效"),
            Self::UnknownTree(tree) => write!(formatter, "NativeStateStore tree 不存在: {tree}"),
            Self::Database(message) => write!(formatter, "NativeStateStore 数据库错误: {message}"),
            Self::Credential(message) => {
                write!(formatter, "NativeStateStore 系统密钥错误: {message}")
            }
            Self::Crypto => formatter.write_str("NativeStateStore 加密记录无效"),
            Self::Serialization(message) => {
                write!(formatter, "NativeStateStore 记录格式错误: {message}")
            }
            Self::RevisionConflict { expected, actual } => write!(
                formatter,
                "NativeStateStore revision 冲突: expected {expected}, actual {actual}"
            ),
            Self::IdempotencyConflict => formatter.write_str("NativeStateStore 幂等键对应不同内容"),
            Self::CorruptRecord { tree, key_digest } => {
                write!(
                    formatter,
                    "NativeStateStore 已隔离损坏记录 {tree}:{key_digest}"
                )
            }
            Self::ArtifactIntegrity => formatter.write_str("NativeStateStore artifact 完整性失败"),
        }
    }
}

impl std::error::Error for StateStoreError {}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StateRecord<T> {
    pub schema_version: u16,
    pub revision: u64,
    pub created_at: u64,
    pub updated_at: u64,
    pub source_id: String,
    pub payload: T,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PutOnceOutcome<T> {
    pub inserted: bool,
    pub record: StateRecord<T>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CorruptRecord {
    pub tree: String,
    pub key_digest: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ScanResult<T> {
    pub records: Vec<StateRecord<T>>,
    pub corruptions: Vec<CorruptRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactMetadata {
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ArtifactRef {
    pub sha256: String,
    pub byte_length: u64,
}

pub trait MasterKeyProvider: Send + Sync {
    fn load_or_create(&self, store_identity: &str) -> Result<[u8; 32], StateStoreError>;
}

struct SystemMasterKeyProvider;

impl MasterKeyProvider for SystemMasterKeyProvider {
    fn load_or_create(&self, store_identity: &str) -> Result<[u8; 32], StateStoreError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, store_identity)
            .map_err(|error| StateStoreError::Credential(error.to_string()))?;
        match entry.get_password() {
            Ok(encoded) => decode_master_key(&encoded),
            Err(keyring::Error::NoEntry) => {
                let mut key = [0_u8; 32];
                getrandom::getrandom(&mut key)
                    .map_err(|error| StateStoreError::Credential(error.to_string()))?;
                entry
                    .set_password(&BASE64.encode(key))
                    .map_err(|error| StateStoreError::Credential(error.to_string()))?;
                Ok(key)
            }
            Err(error) => Err(StateStoreError::Credential(error.to_string())),
        }
    }
}

fn decode_master_key(value: &str) -> Result<[u8; 32], StateStoreError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| StateStoreError::Credential("系统密钥编码无效".into()))?;
    bytes
        .try_into()
        .map_err(|_| StateStoreError::Credential("系统密钥长度无效".into()))
}

struct StoreTrees {
    sessions: Tree,
    events: Tree,
    memory: Tree,
    index: Tree,
    artifact_metadata: Tree,
    artifacts: Tree,
    checkpoints: Tree,
    usage: Tree,
    tombstones: Tree,
}

impl StoreTrees {
    fn open(db: &Db) -> Result<Self, StateStoreError> {
        let open = |name: &str| {
            db.open_tree(name)
                .map_err(|error| StateStoreError::Database(error.to_string()))
        };
        Ok(Self {
            sessions: open(TREE_SESSIONS)?,
            events: open(TREE_EVENTS)?,
            memory: open(TREE_MEMORY)?,
            index: open(TREE_INDEX)?,
            artifact_metadata: open(TREE_ARTIFACT_METADATA)?,
            artifacts: open(TREE_ARTIFACTS)?,
            checkpoints: open(TREE_CHECKPOINTS)?,
            usage: open(TREE_USAGE)?,
            tombstones: open(TREE_TOMBSTONES)?,
        })
    }

    fn get(&self, name: &str) -> Result<&Tree, StateStoreError> {
        match name {
            TREE_SESSIONS => Ok(&self.sessions),
            TREE_EVENTS => Ok(&self.events),
            TREE_MEMORY => Ok(&self.memory),
            TREE_INDEX => Ok(&self.index),
            TREE_ARTIFACT_METADATA => Ok(&self.artifact_metadata),
            TREE_ARTIFACTS => Ok(&self.artifacts),
            TREE_CHECKPOINTS => Ok(&self.checkpoints),
            TREE_USAGE => Ok(&self.usage),
            TREE_TOMBSTONES => Ok(&self.tombstones),
            _ => Err(StateStoreError::UnknownTree(name.to_string())),
        }
    }
}

struct StoreInner {
    path: PathBuf,
    db: Db,
    trees: StoreTrees,
    cipher: Aes256Gcm,
}

#[derive(Clone)]
pub struct NativeStateStore {
    inner: Arc<StoreInner>,
}

impl NativeStateStore {
    pub fn open(app_data_dir: &Path) -> Result<Self, StateStoreError> {
        Self::open_with_key_provider(app_data_dir, Arc::new(SystemMasterKeyProvider))
    }

    fn open_with_key_provider(
        app_data_dir: &Path,
        keys: Arc<dyn MasterKeyProvider>,
    ) -> Result<Self, StateStoreError> {
        std::fs::create_dir_all(app_data_dir)
            .map_err(|error| StateStoreError::Database(error.to_string()))?;
        let root = app_data_dir
            .canonicalize()
            .map_err(|_| StateStoreError::InvalidPath)?;
        let path = root.join(STORE_DIRECTORY);
        let registry = OPEN_STORES.get_or_init(|| Mutex::new(HashMap::new()));
        let mut stores = registry
            .lock()
            .map_err(|_| StateStoreError::Database("进程级 store 注册表已损坏".into()))?;
        if let Some(inner) = stores.get(&path).and_then(Weak::upgrade) {
            return Ok(Self { inner });
        }

        let store_identity = hex_digest(path.to_string_lossy().as_bytes());
        let key = keys.load_or_create(&store_identity)?;
        let db = sled::Config::new()
            .path(&path)
            .mode(sled::Mode::HighThroughput)
            .flush_every_ms(None)
            .open()
            .map_err(|error| StateStoreError::Database(error.to_string()))?;
        let trees = StoreTrees::open(&db)?;
        let inner = Arc::new(StoreInner {
            path: path.clone(),
            db,
            trees,
            cipher: Aes256Gcm::new_from_slice(&key).map_err(|_| StateStoreError::Crypto)?,
        });
        stores.insert(path, Arc::downgrade(&inner));
        Ok(Self { inner })
    }

    #[cfg(test)]
    pub fn open_for_test(app_data_dir: &Path, key: [u8; 32]) -> Result<Self, StateStoreError> {
        struct TestKey([u8; 32]);
        impl MasterKeyProvider for TestKey {
            fn load_or_create(&self, _store_identity: &str) -> Result<[u8; 32], StateStoreError> {
                Ok(self.0)
            }
        }
        Self::open_with_key_provider(app_data_dir, Arc::new(TestKey(key)))
    }

    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    pub fn shares_database_with(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    pub fn background_task_count(&self) -> usize {
        0
    }

    pub fn plaintext_cache_bytes(&self) -> usize {
        0
    }

    pub fn put_cas<T>(
        &self,
        tree_name: &str,
        id: &str,
        source_id: &str,
        expected_revision: u64,
        payload: T,
    ) -> Result<StateRecord<T>, StateStoreError>
    where
        T: Clone + DeserializeOwned + Serialize,
    {
        validate_identity(id)?;
        validate_identity(source_id)?;
        let tree = self.inner.trees.get(tree_name)?;
        let key = record_key(id);
        let now = now_ms();
        let cipher = &self.inner.cipher;
        let result = tree.transaction(|transactional| {
            let current = transactional.get(key.as_slice())?;
            let (actual, created_at) = match current {
                Some(bytes) => {
                    let record: StateRecord<T> = decrypt_json(cipher, tree_name, &key, &bytes)
                        .map_err(ConflictableTransactionError::Abort)?;
                    (record.revision, record.created_at)
                }
                None => (0, now),
            };
            if actual != expected_revision {
                return Err(ConflictableTransactionError::Abort(
                    StateStoreError::RevisionConflict {
                        expected: expected_revision,
                        actual,
                    },
                ));
            }
            let record = StateRecord {
                schema_version: SCHEMA_VERSION,
                revision: actual + 1,
                created_at,
                updated_at: now,
                source_id: source_id.to_string(),
                payload: payload.clone(),
            };
            let encoded = encrypt_json(cipher, tree_name, &key, &record)
                .map_err(ConflictableTransactionError::Abort)?;
            transactional.insert(key.as_slice(), encoded)?;
            Ok(record)
        });
        map_transaction(result)
    }

    pub fn get<T>(
        &self,
        tree_name: &str,
        id: &str,
    ) -> Result<Option<StateRecord<T>>, StateStoreError>
    where
        T: DeserializeOwned,
    {
        validate_identity(id)?;
        let tree = self.inner.trees.get(tree_name)?;
        let key = record_key(id);
        let Some(bytes) = tree
            .get(key)
            .map_err(|error| StateStoreError::Database(error.to_string()))?
        else {
            return Ok(None);
        };
        match decrypt_json(&self.inner.cipher, tree_name, &key, &bytes) {
            Ok(record) => Ok(Some(record)),
            Err(_) => {
                self.quarantine(tree_name, &key, &bytes)?;
                Err(StateStoreError::CorruptRecord {
                    tree: tree_name.to_string(),
                    key_digest: hex_digest(&key),
                })
            }
        }
    }

    pub fn put_once<T>(
        &self,
        tree_name: &str,
        id: &str,
        source_id: &str,
        payload: T,
    ) -> Result<PutOnceOutcome<T>, StateStoreError>
    where
        T: Clone + DeserializeOwned + PartialEq + Serialize,
    {
        validate_identity(id)?;
        validate_identity(source_id)?;
        let tree = self.inner.trees.get(tree_name)?;
        let key = record_key(id);
        let now = now_ms();
        let cipher = &self.inner.cipher;
        let result = tree.transaction(|transactional| {
            if let Some(bytes) = transactional.get(key.as_slice())? {
                let record: StateRecord<T> = decrypt_json(cipher, tree_name, &key, &bytes)
                    .map_err(ConflictableTransactionError::Abort)?;
                if record.source_id != source_id || record.payload != payload {
                    return Err(ConflictableTransactionError::Abort(
                        StateStoreError::IdempotencyConflict,
                    ));
                }
                return Ok(PutOnceOutcome {
                    inserted: false,
                    record,
                });
            }
            let record = StateRecord {
                schema_version: SCHEMA_VERSION,
                revision: 1,
                created_at: now,
                updated_at: now,
                source_id: source_id.to_string(),
                payload: payload.clone(),
            };
            let encoded = encrypt_json(cipher, tree_name, &key, &record)
                .map_err(ConflictableTransactionError::Abort)?;
            transactional.insert(key.as_slice(), encoded)?;
            Ok(PutOnceOutcome {
                inserted: true,
                record,
            })
        });
        map_transaction(result)
    }

    pub fn put_latest<T>(
        &self,
        tree_name: &str,
        id: &str,
        source_id: &str,
        payload: T,
    ) -> Result<StateRecord<T>, StateStoreError>
    where
        T: Clone + DeserializeOwned + Serialize,
    {
        for _ in 0..4 {
            let revision = self
                .get::<T>(tree_name, id)?
                .map_or(0, |record| record.revision);
            match self.put_cas(tree_name, id, source_id, revision, payload.clone()) {
                Ok(record) => return Ok(record),
                Err(StateStoreError::RevisionConflict { .. }) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(StateStoreError::Database("记录并发更新超过重试上限".into()))
    }

    pub fn delete(&self, tree_name: &str, id: &str) -> Result<bool, StateStoreError> {
        validate_identity(id)?;
        self.inner
            .trees
            .get(tree_name)?
            .remove(record_key(id))
            .map(|value| value.is_some())
            .map_err(|error| StateStoreError::Database(error.to_string()))
    }

    pub fn upsert_usage(
        &self,
        invocation_id: &str,
        value: serde_json::Value,
    ) -> Result<StateRecord<serde_json::Value>, StateStoreError> {
        for _ in 0..4 {
            let revision = self
                .get::<serde_json::Value>(TREE_USAGE, invocation_id)?
                .map_or(0, |record| record.revision);
            match self.put_cas(
                TREE_USAGE,
                invocation_id,
                "model-gateway",
                revision,
                value.clone(),
            ) {
                Ok(record) => {
                    self.flush()?;
                    return Ok(record);
                }
                Err(StateStoreError::RevisionConflict { .. }) => continue,
                Err(error) => return Err(error),
            }
        }
        Err(StateStoreError::Database(
            "模型用量记录并发更新超过重试上限".into(),
        ))
    }

    pub fn scan<T>(&self, tree_name: &str) -> Result<ScanResult<T>, StateStoreError>
    where
        T: DeserializeOwned,
    {
        let tree = self.inner.trees.get(tree_name)?;
        let mut records = Vec::new();
        let mut damaged = Vec::new();
        for entry in tree.iter() {
            let (key, bytes) =
                entry.map_err(|error| StateStoreError::Database(error.to_string()))?;
            match decrypt_json(&self.inner.cipher, tree_name, &key, &bytes) {
                Ok(record) => records.push(record),
                Err(_) => damaged.push((key.to_vec(), bytes.to_vec())),
            }
        }
        let mut corruptions = Vec::with_capacity(damaged.len());
        for (key, bytes) in damaged {
            self.quarantine(tree_name, &key, &bytes)?;
            corruptions.push(CorruptRecord {
                tree: tree_name.to_string(),
                key_digest: hex_digest(&key),
            });
        }
        Ok(ScanResult {
            records,
            corruptions,
        })
    }

    pub fn commit_checkpoint_event(
        &self,
        checkpoint_id: &str,
        event_id: &str,
        source_id: &str,
        checkpoint: &serde_json::Value,
        event: &serde_json::Value,
    ) -> Result<(), StateStoreError> {
        validate_identity(checkpoint_id)?;
        validate_identity(event_id)?;
        validate_identity(source_id)?;
        let checkpoint_key = record_key(checkpoint_id);
        let event_key = record_key(event_id);
        let now = now_ms();
        let checkpoint_record = new_record(source_id, checkpoint.clone(), now);
        let event_record = new_record(source_id, event.clone(), now);
        let checkpoint_bytes = encrypt_json(
            &self.inner.cipher,
            TREE_CHECKPOINTS,
            &checkpoint_key,
            &checkpoint_record,
        )?;
        let event_bytes = encrypt_json(&self.inner.cipher, TREE_EVENTS, &event_key, &event_record)?;
        let result = (&self.inner.trees.checkpoints, &self.inner.trees.events).transaction(
            |(checkpoints, events)| {
                if checkpoints.get(checkpoint_key.as_slice())?.is_some()
                    || events.get(event_key.as_slice())?.is_some()
                {
                    return Err(ConflictableTransactionError::Abort(
                        StateStoreError::IdempotencyConflict,
                    ));
                }
                checkpoints.insert(checkpoint_key.as_slice(), checkpoint_bytes.clone())?;
                events.insert(event_key.as_slice(), event_bytes.clone())?;
                Ok(())
            },
        );
        map_transaction(result)
    }

    pub fn commit_latest_index_event<T, E>(
        &self,
        index_id: &str,
        registry_id: &str,
        registry_member: &str,
        event_id: &str,
        source_id: &str,
        index_payload: &T,
        event_payload: &E,
    ) -> Result<(), StateStoreError>
    where
        T: Clone + DeserializeOwned + Serialize,
        E: Clone + DeserializeOwned + Serialize,
    {
        validate_identity(index_id)?;
        validate_identity(registry_id)?;
        validate_identity(registry_member)?;
        validate_identity(event_id)?;
        validate_identity(source_id)?;
        let index_key = record_key(index_id);
        let registry_key = record_key(registry_id);
        let event_key = record_key(event_id);
        let now = now_ms();
        let cipher = &self.inner.cipher;
        let result =
            (&self.inner.trees.index, &self.inner.trees.events).transaction(|(index, events)| {
                if events.get(event_key.as_slice())?.is_some() {
                    return Err(ConflictableTransactionError::Abort(
                        StateStoreError::IdempotencyConflict,
                    ));
                }
                let (revision, created_at) = match index.get(index_key.as_slice())? {
                    Some(bytes) => {
                        let current: StateRecord<T> =
                            decrypt_json(cipher, TREE_INDEX, &index_key, &bytes)
                                .map_err(ConflictableTransactionError::Abort)?;
                        (current.revision + 1, current.created_at)
                    }
                    None => (1, now),
                };
                let index_record = StateRecord {
                    schema_version: SCHEMA_VERSION,
                    revision,
                    created_at,
                    updated_at: now,
                    source_id: source_id.to_string(),
                    payload: index_payload.clone(),
                };
                let event_record = new_record(source_id, event_payload.clone(), now);
                let (registry_revision, registry_created_at, mut registry_payload) =
                    match index.get(registry_key.as_slice())? {
                        Some(bytes) => {
                            let current: StateRecord<BTreeSet<String>> =
                                decrypt_json(cipher, TREE_INDEX, &registry_key, &bytes)
                                    .map_err(ConflictableTransactionError::Abort)?;
                            (current.revision + 1, current.created_at, current.payload)
                        }
                        None => (1, now, BTreeSet::new()),
                    };
                registry_payload.insert(registry_member.to_string());
                let registry_record = StateRecord {
                    schema_version: SCHEMA_VERSION,
                    revision: registry_revision,
                    created_at: registry_created_at,
                    updated_at: now,
                    source_id: source_id.to_string(),
                    payload: registry_payload,
                };
                let index_bytes = encrypt_json(cipher, TREE_INDEX, &index_key, &index_record)
                    .map_err(ConflictableTransactionError::Abort)?;
                let event_bytes = encrypt_json(cipher, TREE_EVENTS, &event_key, &event_record)
                    .map_err(ConflictableTransactionError::Abort)?;
                let registry_bytes =
                    encrypt_json(cipher, TREE_INDEX, &registry_key, &registry_record)
                        .map_err(ConflictableTransactionError::Abort)?;
                index.insert(index_key.as_slice(), index_bytes)?;
                index.insert(registry_key.as_slice(), registry_bytes)?;
                events.insert(event_key.as_slice(), event_bytes)?;
                Ok(())
            });
        map_transaction(result)
    }

    pub fn put_artifact(
        &self,
        source_id: &str,
        bytes: &[u8],
    ) -> Result<ArtifactRef, StateStoreError> {
        validate_identity(source_id)?;
        let digest = hex_digest(bytes);
        let key = record_key(&digest);
        let metadata = ArtifactMetadata {
            sha256: digest.clone(),
            byte_length: bytes.len() as u64,
        };
        let record = new_record(source_id, metadata.clone(), now_ms());
        let encrypted_metadata =
            encrypt_json(&self.inner.cipher, TREE_ARTIFACT_METADATA, &key, &record)?;
        let encrypted_artifact = encrypt_bytes(&self.inner.cipher, TREE_ARTIFACTS, &key, bytes)?;
        let result = (
            &self.inner.trees.artifact_metadata,
            &self.inner.trees.artifacts,
        )
            .transaction(|(metadata_tree, artifact_tree)| {
                match (
                    metadata_tree.get(key.as_slice())?,
                    artifact_tree.get(key.as_slice())?,
                ) {
                    (None, None) => {
                        metadata_tree.insert(key.as_slice(), encrypted_metadata.clone())?;
                        artifact_tree.insert(key.as_slice(), encrypted_artifact.clone())?;
                    }
                    (Some(existing_metadata), Some(existing_artifact)) => {
                        let existing: StateRecord<ArtifactMetadata> = decrypt_json(
                            &self.inner.cipher,
                            TREE_ARTIFACT_METADATA,
                            &key,
                            &existing_metadata,
                        )
                        .map_err(ConflictableTransactionError::Abort)?;
                        let existing_bytes = decrypt_bytes(
                            &self.inner.cipher,
                            TREE_ARTIFACTS,
                            &key,
                            &existing_artifact,
                        )
                        .map_err(ConflictableTransactionError::Abort)?;
                        if existing.payload != metadata || existing_bytes != bytes {
                            return Err(ConflictableTransactionError::Abort(
                                StateStoreError::ArtifactIntegrity,
                            ));
                        }
                    }
                    _ => {
                        return Err(ConflictableTransactionError::Abort(
                            StateStoreError::ArtifactIntegrity,
                        ));
                    }
                }
                Ok(())
            });
        map_transaction(result)?;
        Ok(ArtifactRef {
            sha256: digest,
            byte_length: bytes.len() as u64,
        })
    }

    pub fn read_artifact(&self, reference: &ArtifactRef) -> Result<Vec<u8>, StateStoreError> {
        let key = record_key(&reference.sha256);
        let Some(bytes) = self
            .inner
            .trees
            .artifacts
            .get(key)
            .map_err(|error| StateStoreError::Database(error.to_string()))?
        else {
            return Err(StateStoreError::ArtifactIntegrity);
        };
        let plaintext = decrypt_bytes(&self.inner.cipher, TREE_ARTIFACTS, &key, &bytes)?;
        if plaintext.len() as u64 != reference.byte_length
            || hex_digest(&plaintext) != reference.sha256
        {
            return Err(StateStoreError::ArtifactIntegrity);
        }
        Ok(plaintext)
    }

    pub fn count(&self, tree_name: &str) -> Result<usize, StateStoreError> {
        Ok(self.inner.trees.get(tree_name)?.len())
    }

    pub fn flush(&self) -> Result<(), StateStoreError> {
        self.inner
            .db
            .flush()
            .map(|_| ())
            .map_err(|error| StateStoreError::Database(error.to_string()))
    }

    fn quarantine(&self, tree_name: &str, key: &[u8], bytes: &[u8]) -> Result<(), StateStoreError> {
        let source = self.inner.trees.get(tree_name)?;
        let quarantine_key = record_key(&format!(
            "corrupt:{tree_name}:{}:{}",
            hex_digest(key),
            now_ms()
        ));
        let encrypted = encrypt_bytes(&self.inner.cipher, TREE_TOMBSTONES, &quarantine_key, bytes)?;
        let result = (source, &self.inner.trees.tombstones).transaction(|(origin, tombstones)| {
            origin.remove(key)?;
            tombstones.insert(quarantine_key.as_slice(), encrypted.clone())?;
            Ok(())
        });
        map_transaction(result)
    }

    #[cfg(test)]
    pub(crate) fn inject_corrupt_record(&self, tree_name: &str, id: &str) {
        self.inner
            .trees
            .get(tree_name)
            .unwrap()
            .insert(record_key(id), b"not-encrypted".as_slice())
            .unwrap();
    }
}

fn validate_identity(value: &str) -> Result<(), StateStoreError> {
    if value.trim().is_empty() || value.len() > 512 || value.bytes().any(|byte| byte == 0) {
        Err(StateStoreError::Serialization("记录 ID 无效".into()))
    } else {
        Ok(())
    }
}

fn new_record<T>(source_id: &str, payload: T, now: u64) -> StateRecord<T> {
    StateRecord {
        schema_version: SCHEMA_VERSION,
        revision: 1,
        created_at: now,
        updated_at: now,
        source_id: source_id.to_string(),
        payload,
    }
}

fn record_key(id: &str) -> [u8; 32] {
    Sha256::digest(id.as_bytes()).into()
}

fn associated_data(tree_name: &str, key: &[u8]) -> Vec<u8> {
    let mut data = Vec::with_capacity(tree_name.len() + 1 + key.len());
    data.extend_from_slice(tree_name.as_bytes());
    data.push(0);
    data.extend_from_slice(key);
    data
}

fn encrypt_json<T: Serialize>(
    cipher: &Aes256Gcm,
    tree_name: &str,
    key: &[u8],
    value: &T,
) -> Result<Vec<u8>, StateStoreError> {
    let plaintext = serde_json::to_vec(value)
        .map_err(|error| StateStoreError::Serialization(error.to_string()))?;
    encrypt_bytes(cipher, tree_name, key, &plaintext)
}

fn decrypt_json<T: DeserializeOwned>(
    cipher: &Aes256Gcm,
    tree_name: &str,
    key: &[u8],
    value: &[u8],
) -> Result<T, StateStoreError> {
    let plaintext = decrypt_bytes(cipher, tree_name, key, value)?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| StateStoreError::Serialization(error.to_string()))
}

fn encrypt_bytes(
    cipher: &Aes256Gcm,
    tree_name: &str,
    key: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, StateStoreError> {
    let mut nonce = [0_u8; NONCE_BYTES];
    getrandom::getrandom(&mut nonce).map_err(|_| StateStoreError::Crypto)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &associated_data(tree_name, key),
            },
        )
        .map_err(|_| StateStoreError::Crypto)?;
    let mut encoded = Vec::with_capacity(1 + NONCE_BYTES + ciphertext.len());
    encoded.push(CIPHERTEXT_VERSION);
    encoded.extend_from_slice(&nonce);
    encoded.extend_from_slice(&ciphertext);
    Ok(encoded)
}

fn decrypt_bytes(
    cipher: &Aes256Gcm,
    tree_name: &str,
    key: &[u8],
    value: &[u8],
) -> Result<Vec<u8>, StateStoreError> {
    if value.len() <= 1 + NONCE_BYTES || value[0] != CIPHERTEXT_VERSION {
        return Err(StateStoreError::Crypto);
    }
    cipher
        .decrypt(
            Nonce::from_slice(&value[1..1 + NONCE_BYTES]),
            Payload {
                msg: &value[1 + NONCE_BYTES..],
                aad: &associated_data(tree_name, key),
            },
        )
        .map_err(|_| StateStoreError::Crypto)
}

fn map_transaction<T>(
    result: Result<T, TransactionError<StateStoreError>>,
) -> Result<T, StateStoreError> {
    match result {
        Ok(value) => Ok(value),
        Err(TransactionError::Abort(error)) => Err(error),
        Err(TransactionError::Storage(error)) => Err(StateStoreError::Database(error.to_string())),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::process::Command;
    use std::sync::Barrier;

    struct FixedKey([u8; 32]);

    impl MasterKeyProvider for FixedKey {
        fn load_or_create(&self, _store_identity: &str) -> Result<[u8; 32], StateStoreError> {
            Ok(self.0)
        }
    }

    fn store(root: &Path) -> NativeStateStore {
        NativeStateStore::open_with_key_provider(root, Arc::new(FixedKey([7; 32]))).unwrap()
    }

    fn read_files(root: &Path) -> Vec<u8> {
        let mut all = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(path) = pending.pop() {
            for entry in fs::read_dir(path).unwrap() {
                let entry = entry.unwrap();
                if entry.file_type().unwrap().is_dir() {
                    pending.push(entry.path());
                } else {
                    all.extend(fs::read(entry.path()).unwrap());
                }
            }
        }
        all
    }

    #[test]
    fn one_process_path_uses_one_database_and_all_required_trees() {
        let root = tempfile::tempdir().unwrap();
        let first = store(root.path());
        let second = store(root.path());
        assert!(first.shares_database_with(&second));
        for tree in REQUIRED_TREES {
            assert_eq!(first.count(tree).unwrap(), 0, "{tree}");
        }
        assert_eq!(first.background_task_count(), 0);
        assert_eq!(first.plaintext_cache_bytes(), 0);
    }

    #[test]
    fn database_files_do_not_contain_plaintext_content_or_master_key() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        store
            .put_cas(
                TREE_SESSIONS,
                "session-secret-id",
                "user-source",
                0,
                json!({"message":"plaintext-message-secret"}),
            )
            .unwrap();
        store
            .put_once(
                TREE_EVENTS,
                "event-secret-id",
                "tool-source",
                json!({"output":"plaintext-tool-output"}),
            )
            .unwrap();
        store
            .put_artifact("tool-source", b"plaintext-large-artifact")
            .unwrap();
        store.flush().unwrap();
        let store_path = store.path().to_path_buf();
        // Windows keeps sled files exclusively locked until the final DB handle is released.
        drop(store);
        let disk = read_files(&store_path);
        for forbidden in [
            b"plaintext-message-secret".as_slice(),
            b"plaintext-tool-output".as_slice(),
            b"plaintext-large-artifact".as_slice(),
            &[7_u8; 32],
        ] {
            assert!(!disk
                .windows(forbidden.len())
                .any(|window| window == forbidden));
        }
    }

    #[test]
    fn event_and_usage_replay_one_hundred_times_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        for _ in 0..100 {
            assert_eq!(
                store
                    .put_once(TREE_EVENTS, "event-1", "runtime", json!({"kind":"turn"}))
                    .unwrap()
                    .record
                    .revision,
                1
            );
            store
                .put_once(TREE_USAGE, "invocation-1", "gateway", json!({"tokens":12}))
                .unwrap();
        }
        assert_eq!(store.count(TREE_EVENTS).unwrap(), 1);
        assert_eq!(store.count(TREE_USAGE).unwrap(), 1);
    }

    #[test]
    fn kernel_turn_registry_and_event_commit_atomically() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        store
            .commit_latest_index_event(
                "kernel-turn-turn-1",
                "runtime-kernel-turns",
                "turn-1",
                "kernel-event-turn-1-1",
                "runtime-kernel",
                &json!({"turnId":"turn-1","sequence":1}),
                &json!({"turnId":"turn-1","sequence":1,"state":"created"}),
            )
            .unwrap();
        assert_eq!(
            store
                .get::<serde_json::Value>(TREE_INDEX, "kernel-turn-turn-1")
                .unwrap()
                .unwrap()
                .payload["sequence"],
            1
        );
        assert!(store
            .get::<BTreeSet<String>>(TREE_INDEX, "runtime-kernel-turns")
            .unwrap()
            .unwrap()
            .payload
            .contains("turn-1"));
        assert!(store
            .get::<serde_json::Value>(TREE_EVENTS, "kernel-event-turn-1-1")
            .unwrap()
            .is_some());

        let replay = store.commit_latest_index_event(
            "kernel-turn-turn-1",
            "runtime-kernel-turns",
            "turn-1",
            "kernel-event-turn-1-1",
            "runtime-kernel",
            &json!({"turnId":"turn-1","sequence":2}),
            &json!({"turnId":"turn-1","sequence":2,"state":"planning"}),
        );
        assert_eq!(replay.unwrap_err(), StateStoreError::IdempotencyConflict);
        assert_eq!(
            store
                .get::<serde_json::Value>(TREE_INDEX, "kernel-turn-turn-1")
                .unwrap()
                .unwrap()
                .payload["sequence"],
            1
        );
    }

    #[test]
    fn concurrent_revision_conflict_never_overwrites_silently() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        store
            .put_cas(TREE_SESSIONS, "session-1", "runtime", 0, json!({"value":0}))
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let results = (1..=2)
            .map(|value| {
                let store = store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.put_cas(
                        TREE_SESSIONS,
                        "session-1",
                        "runtime",
                        1,
                        json!({"value":value}),
                    )
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = results
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(StateStoreError::RevisionConflict { .. })))
                .count(),
            1
        );
        assert_eq!(
            store
                .get::<serde_json::Value>(TREE_SESSIONS, "session-1")
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }

    #[test]
    fn checkpoint_and_event_commit_or_abort_together() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        store
            .put_once(
                TREE_EVENTS,
                "event-existing",
                "runtime",
                json!({"state":"old"}),
            )
            .unwrap();
        assert_eq!(
            store.commit_checkpoint_event(
                "checkpoint-aborted",
                "event-existing",
                "runtime",
                &json!({"file":"a.txt"}),
                &json!({"state":"new"}),
            ),
            Err(StateStoreError::IdempotencyConflict)
        );
        assert!(store
            .get::<serde_json::Value>(TREE_CHECKPOINTS, "checkpoint-aborted")
            .unwrap()
            .is_none());
        store
            .commit_checkpoint_event(
                "checkpoint-committed",
                "event-committed",
                "runtime",
                &json!({"file":"b.txt"}),
                &json!({"state":"confirmed"}),
            )
            .unwrap();
        assert_eq!(store.count(TREE_CHECKPOINTS).unwrap(), 1);
        assert_eq!(store.count(TREE_EVENTS).unwrap(), 2);
    }

    #[test]
    fn corrupt_record_is_quarantined_without_hiding_healthy_sessions() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        store
            .put_cas(TREE_SESSIONS, "healthy-1", "runtime", 0, json!({"ok":1}))
            .unwrap();
        store
            .put_cas(TREE_SESSIONS, "healthy-2", "runtime", 0, json!({"ok":2}))
            .unwrap();
        store.inject_corrupt_record(TREE_SESSIONS, "broken");
        let scan = store.scan::<serde_json::Value>(TREE_SESSIONS).unwrap();
        assert_eq!(scan.records.len(), 2);
        assert_eq!(scan.corruptions.len(), 1);
        assert_eq!(store.count(TREE_SESSIONS).unwrap(), 2);
        assert_eq!(store.count(TREE_TOMBSTONES).unwrap(), 1);
    }

    #[test]
    fn large_artifact_is_content_addressed_and_verified() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let bytes = vec![42_u8; 2 * 1024 * 1024];
        let reference = store.put_artifact("tool-call-1", &bytes).unwrap();
        assert_eq!(reference.byte_length, bytes.len() as u64);
        assert_eq!(store.read_artifact(&reference).unwrap(), bytes);
        assert_eq!(store.count(TREE_ARTIFACTS).unwrap(), 1);
        assert_eq!(store.count(TREE_ARTIFACT_METADATA).unwrap(), 1);
        assert_eq!(store.plaintext_cache_bytes(), 0);
    }

    #[test]
    fn opening_new_store_does_not_read_modify_or_delete_beta_data() {
        let root = tempfile::tempdir().unwrap();
        let beta_state = root.path().join("native-runtime.json");
        let beta_otto = root.path().join(".otto-user");
        fs::write(&beta_state, b"beta-state-byte-sentinel").unwrap();
        fs::write(&beta_otto, b"beta-otto-byte-sentinel").unwrap();
        let before_state = fs::read(&beta_state).unwrap();
        let before_otto = fs::read(&beta_otto).unwrap();
        let store = store(root.path());
        store
            .put_once(TREE_EVENTS, "event-1", "runtime", json!({"ok":true}))
            .unwrap();
        store.flush().unwrap();
        assert_eq!(fs::read(&beta_state).unwrap(), before_state);
        assert_eq!(fs::read(&beta_otto).unwrap(), before_otto);
    }

    #[test]
    #[ignore = "subprocess helper"]
    fn forced_exit_writer_helper() {
        let Some(root) = std::env::var_os("CLAWMASTER_CRASH_STORE") else {
            return;
        };
        let crash_at = std::env::var("CLAWMASTER_CRASH_AT")
            .unwrap()
            .parse::<usize>()
            .unwrap();
        let store = NativeStateStore::open_for_test(Path::new(&root), [61; 32]).unwrap();
        for index in 0..100 {
            store
                .put_latest(
                    TREE_SESSIONS,
                    &format!("session-{index}"),
                    "crash-writer",
                    json!({"index":index,"content":format!("message-{index}")}),
                )
                .unwrap();
            if index % 7 == 0 {
                store.flush().unwrap();
            }
            if index == crash_at {
                std::process::exit(91);
            }
        }
    }

    #[test]
    fn forced_process_exit_recovers_valid_records() {
        for crash_at in [0, 3, 17, 63, 99] {
            let root = tempfile::tempdir().unwrap();
            let status = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "native_state_store::tests::forced_exit_writer_helper",
                    "--ignored",
                ])
                .env("CLAWMASTER_CRASH_STORE", root.path())
                .env("CLAWMASTER_CRASH_AT", crash_at.to_string())
                .status()
                .unwrap();
            assert_eq!(status.code(), Some(91));

            let store = NativeStateStore::open_for_test(root.path(), [61; 32]).unwrap();
            let recovered = store.scan::<serde_json::Value>(TREE_SESSIONS).unwrap();
            assert!(recovered.corruptions.is_empty());
            assert!(recovered.records.len() <= crash_at + 1);
            store
                .put_latest(
                    TREE_SESSIONS,
                    "after-recovery",
                    "recovery-test",
                    json!({"recovered":true}),
                )
                .unwrap();
            store.flush().unwrap();
            assert!(store
                .get::<serde_json::Value>(TREE_SESSIONS, "after-recovery")
                .unwrap()
                .is_some());
        }
    }
}
