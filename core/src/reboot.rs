use log::{error, info};

pub fn trigger_scheduled_reboot(reason: &str) -> ! {
    info!("재시동 수행: {reason}");
    std::process::exit(0);
}

pub fn trigger_failure_reboot(reason: &str) -> ! {
    error!("재시동 수행: {reason}");
    std::process::exit(1);
}

pub fn install_panic_reboot_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        trigger_failure_reboot("치명적인 패닉 발생");
    }));
}
