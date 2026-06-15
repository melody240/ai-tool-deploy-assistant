use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("网络地址不受信任：仅允许 HTTPS")]
    InsecureUrl,
    #[error("网络请求失败：{0}")]
    Network(#[from] reqwest::Error),
    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("数据格式错误：{0}")]
    Json(#[from] serde_json::Error),
    #[error("签名或哈希校验失败：{0}")]
    Verification(String),
    #[error("安装源不存在或已被停用")]
    SourceUnavailable,
    #[error("安装命令失败：{0}")]
    Command(String),
    #[error("配置不安全：{0}")]
    UnsafeConfig(String),
    #[error("{0}")]
    Message(String),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
