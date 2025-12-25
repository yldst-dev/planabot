mod bot;
mod config;
mod hitomi;
mod planabrain;
mod urlchanger;

use anyhow::Result;
use bot::AppState;
use config::Config;
use hitomi::GalleryClient;
use log::info;
use teloxide::Bot;
use teloxide::prelude::Requester;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    let config = Config::load()?;
    let bot = Bot::new(&config.telegram_api_token);

    let me = bot.get_me().await?;
    let bot_username = me.user.username.clone().unwrap_or_default();
    info!("봇 초기화 완료: @{}", bot_username);

    let state = AppState::new(bot_username, GalleryClient::new());

    bot::run(bot, state).await
}
