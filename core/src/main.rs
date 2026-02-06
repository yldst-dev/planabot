mod bot;
mod config;
mod health;
mod hitomi;
mod planabrain;
mod reboot;
mod time;
mod urlchanger;
mod vision;

use anyhow::Result;
use bot::AppState;
use chrono::{FixedOffset, TimeZone, Utc};
use config::Config;
use hitomi::GalleryClient;
use log::info;
use teloxide::Bot;
use teloxide::prelude::Requester;
use tokio::time::sleep;

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();
    health::init_start_time();
    reboot::install_panic_reboot_hook();

    let config = Config::load()?;
    let bot = Bot::new(&config.telegram_api_token);

    tokio::spawn(health::run_health_server());
    spawn_reboot_scheduler();

    let me = get_me_or_reboot(&bot).await?;
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

    if let Err(err) = bot::run(bot, state).await {
        log::error!("치명적인 오류 발생: {:?}", err);
        reboot::trigger_failure_reboot("치명적인 오류 발생");
    }

    Ok(())
}

async fn get_me_or_reboot(bot: &Bot) -> Result<teloxide::types::Me> {
    match bot.get_me().await {
        Ok(me) => Ok(me),
        Err(err) => {
            log::error!("GetMe 요청 실패: {:?}", err);
            if bot::should_reboot_on_request_error(&err) {
                reboot::trigger_failure_reboot("텔레그램 GetMe 통신 오류로 인한 재시동");
            }
            Err(err.into())
        }
    }
}

fn spawn_reboot_scheduler() {
    tokio::spawn(async {
        let offset = FixedOffset::east_opt(9 * 3600).expect("KST offset should be valid");
        let now = Utc::now().with_timezone(&offset);
        let today = now.date_naive();
        let today_midnight = offset
            .from_local_datetime(&today.and_hms_opt(0, 0, 0).unwrap())
            .unwrap();
        let next = if now < today_midnight {
            today_midnight
        } else {
            let tomorrow = today.succ_opt().unwrap();
            offset
                .from_local_datetime(&tomorrow.and_hms_opt(0, 0, 0).unwrap())
                .unwrap()
        };

        let delay = (next - now).to_std().unwrap_or_default();
        info!(
            "다음 재부팅 예약: {} (KST)",
            next.format("%Y-%m-%d %H:%M:%S")
        );
        sleep(delay).await;
        info!("재부팅 예약 시간 도달: 프로세스를 종료합니다.");
        reboot::trigger_scheduled_reboot("KST 자정 정기 재시동");
    });
}
