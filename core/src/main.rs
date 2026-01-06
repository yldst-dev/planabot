mod bot;
mod config;
mod hitomi;
mod planabrain;
mod urlchanger;

use anyhow::Result;
use bot::AppState;
use chrono::{FixedOffset, TimeZone, Utc};
use config::Config;
use hitomi::GalleryClient;
use log::{info, warn};
use std::time::Duration;
use teloxide::Bot;
use teloxide::prelude::Requester;
use tokio::time::sleep;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();

    let config = Config::load()?;
    let bot = Bot::new(&config.telegram_api_token);

    spawn_reboot_scheduler();

    let me = get_me_with_retry(&bot).await?;
    let bot_username = me.user.username.clone().unwrap_or_default();
    let bot_user_id = me.user.id;
    info!("봇 초기화 완료: @{}", bot_username);

    let notice_chat_id = config.notice_chat_id.map(teloxide::types::ChatId);
    let notice_url = Some(config.notice_url.clone()).filter(|raw| !raw.trim().is_empty());
    let state = AppState::new(
        bot_username,
        bot_user_id,
        GalleryClient::new(),
        notice_chat_id,
        notice_url,
    );

    bot::announce_startup(&bot, &state).await;
    bot::run(bot, state).await
}

async fn get_me_with_retry(bot: &Bot) -> Result<teloxide::types::Me> {
    let mut attempt = 0;

    loop {
        attempt += 1;
        match bot.get_me().await {
            Ok(me) => return Ok(me),
            Err(err) => {
                let backoff = Duration::from_secs((2 * attempt).min(30) as u64);
                warn!(
                    "GetMe 요청 실패 (시도 {}): {}. {:?} 후 재시도합니다.",
                    attempt, err, backoff
                );
                sleep(backoff).await;
            }
        }
    }
}

fn spawn_reboot_scheduler() {
    tokio::spawn(async {
        let offset = FixedOffset::east_opt(9 * 3600).expect("KST offset should be valid");
        let now = Utc::now().with_timezone(&offset);
        let today = now.date_naive();
        let six = offset
            .from_local_datetime(&today.and_hms_opt(6, 0, 0).unwrap())
            .unwrap();
        let eighteen = offset
            .from_local_datetime(&today.and_hms_opt(18, 0, 0).unwrap())
            .unwrap();

        let next = if now < six {
            six
        } else if now < eighteen {
            eighteen
        } else {
            let tomorrow = today.succ_opt().unwrap();
            offset
                .from_local_datetime(&tomorrow.and_hms_opt(6, 0, 0).unwrap())
                .unwrap()
        };

        let delay = (next - now).to_std().unwrap_or_default();
        info!(
            "다음 재부팅 예약: {} (KST)",
            next.format("%Y-%m-%d %H:%M:%S")
        );
        sleep(delay).await;
        info!("재부팅 예약 시간 도달: 프로세스를 종료합니다.");
        std::process::exit(0);
    });
}
