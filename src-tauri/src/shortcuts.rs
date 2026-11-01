//! Global hotkeys. The manager lives on a dedicated thread (Win32 message loop)
//! and talks to the app through a command channel, so registering keys never
//! blocks the UI.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;

use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};

use crate::app::App;
use crate::logger::LOGGER;
use crate::types::HotkeyStatus;

pub enum HotkeyCommand {
    Apply {
        toggle: String,
        capture: String,
        reply: Sender<Result<(), String>>,
    },
    Suspend(Sender<()>),
    Resume(Sender<()>),
    Stop,
}

#[derive(Clone)]
pub struct HotkeyHandle {
    sender: Sender<HotkeyCommand>,
}

const DEFAULT_TOGGLE: &str = "Control+Alt+Shift+Space";
const DEFAULT_CAPTURE: &str = "Control+Shift+D";

impl HotkeyHandle {
    pub fn apply(&self, toggle: &str, capture: &str) -> Result<(), String> {
        let (tx, rx) = channel();
        if self
            .sender
            .send(HotkeyCommand::Apply {
                toggle: toggle.to_string(),
                capture: capture.to_string(),
                reply: tx,
            })
            .is_err()
        {
            return Err("快捷键服务不可用。".into());
        }
        rx.recv_timeout(std::time::Duration::from_secs(3))
            .unwrap_or_else(|_| Err("快捷键注册超时。".into()))
    }

    pub fn suspend(&self) {
        let (tx, rx) = channel();
        let _ = self.sender.send(HotkeyCommand::Suspend(tx));
        let _ = rx.recv_timeout(std::time::Duration::from_secs(2));
    }

    pub fn resume(&self) {
        let (tx, rx) = channel();
        let _ = self.sender.send(HotkeyCommand::Resume(tx));
        let _ = rx.recv_timeout(std::time::Duration::from_secs(2));
    }
}

pub fn spawn(app: Arc<App>) -> HotkeyHandle {
    let (tx, rx) = channel::<HotkeyCommand>();
    std::thread::spawn(move || {
        let manager = match GlobalHotKeyManager::new() {
            Ok(manager) => manager,
            Err(error) => {
                LOGGER.error(
                    "hotkeys.manager_failed",
                    Some(serde_json::json!({ "error": error.to_string() })),
                );
                return;
            }
        };
        let mut registered: HashMap<u32, (HotKey, &'static str)> = HashMap::new();
        let mut suspended = false;
        let mut desired = (DEFAULT_TOGGLE.to_string(), DEFAULT_CAPTURE.to_string());
        let receiver = GlobalHotKeyEvent::receiver();

        loop {
            while let Ok(event) = receiver.try_recv() {
                if event.state != HotKeyState::Pressed {
                    continue;
                }
                if let Some((_, action)) = registered.get(&event.id) {
                    dispatch(&app, action);
                }
            }
            match rx.recv_timeout(std::time::Duration::from_millis(120)) {
                Ok(HotkeyCommand::Apply {
                    toggle,
                    capture,
                    reply,
                }) => {
                    desired = (toggle.clone(), capture.clone());
                    if suspended {
                        let _ = reply.send(Ok(()));
                        continue;
                    }
                    unregister_all(&manager, &mut registered);
                    let result = register_pair(&app, &manager, &mut registered, &toggle, &capture);
                    if let Err(message) = &result {
                        unregister_all(&manager, &mut registered);
                        let previous = app.hotkeys.lock().clone();
                        let current_toggle = if previous.toggle.accelerator.is_empty() {
                            DEFAULT_TOGGLE.to_string()
                        } else {
                            previous.toggle.accelerator.clone()
                        };
                        let current_capture = if previous.capture.accelerator.is_empty() {
                            DEFAULT_CAPTURE.to_string()
                        } else {
                            previous.capture.accelerator.clone()
                        };
                        let _ = register_pair(
                            &app,
                            &manager,
                            &mut registered,
                            &current_toggle,
                            &current_capture,
                        );
                        LOGGER.warn(
                            "hotkeys.register_failed",
                            Some(serde_json::json!({ "error": message })),
                        );
                    }
                    let _ = reply.send(result);
                }
                Ok(HotkeyCommand::Suspend(reply)) => {
                    suspended = true;
                    unregister_all(&manager, &mut registered);
                    let _ = reply.send(());
                }
                Ok(HotkeyCommand::Resume(reply)) => {
                    suspended = false;
                    unregister_all(&manager, &mut registered);
                    let (toggle, capture) = desired.clone();
                    let _ = register_pair(&app, &manager, &mut registered, &toggle, &capture);
                    let _ = reply.send(());
                }
                Ok(HotkeyCommand::Stop) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    HotkeyHandle { sender: tx }
}

fn dispatch(app: &Arc<App>, action: &str) {
    match action {
        "toggle" => app.toggle_shelf(),
        "capture" => crate::actions::capture_from_hotkey(app),
        _ => {}
    }
}

fn unregister_all(
    manager: &GlobalHotKeyManager,
    registered: &mut HashMap<u32, (HotKey, &'static str)>,
) {
    for (_, (hotkey, _)) in registered.drain() {
        let _ = manager.unregister(hotkey);
    }
}

fn register_pair(
    app: &Arc<App>,
    manager: &GlobalHotKeyManager,
    registered: &mut HashMap<u32, (HotKey, &'static str)>,
    toggle: &str,
    capture: &str,
) -> Result<(), String> {
    if toggle == capture {
        return Err("“呼出/隐藏”和“剪贴板存入”不能使用同一个快捷键。".into());
    }
    let toggle_key = parse_accelerator(toggle)
        .ok_or_else(|| format!("“呼出/隐藏”快捷键 {toggle} 无法识别。"))?;
    let capture_key = parse_accelerator(capture)
        .ok_or_else(|| format!("“剪贴板存入”快捷键 {capture} 无法识别。"))?;

    let toggle_id = toggle_key.id();
    manager.register(toggle_key).map_err(|_| {
        format!("“呼出/隐藏”快捷键 {toggle} 注册失败，可能被其他应用占用。")
    })?;
    registered.insert(toggle_id, (toggle_key, "toggle"));

    let capture_id = capture_key.id();
    if manager.register(capture_key).is_err() {
        return Err(format!(
            "“剪贴板存入”快捷键 {capture} 注册失败，可能被其他应用占用。"
        ));
    }
    registered.insert(capture_id, (capture_key, "capture"));

    *app.hotkeys.lock() = crate::types::HotkeyPair {
        toggle: HotkeyStatus {
            accelerator: toggle.to_string(),
            ok: true,
            error: None,
        },
        capture: HotkeyStatus {
            accelerator: capture.to_string(),
            ok: true,
            error: None,
        },
    };
    LOGGER.info(
        "hotkeys.registered",
        Some(serde_json::json!({ "toggle": toggle, "capture": capture })),
    );
    app.schedule_broadcast();
    Ok(())
}

pub fn mark_failure(app: &Arc<App>, toggle: &str, capture: &str, error: &str) {
    *app.hotkeys.lock() = crate::types::HotkeyPair {
        toggle: HotkeyStatus {
            accelerator: toggle.to_string(),
            ok: false,
            error: Some(error.to_string()),
        },
        capture: HotkeyStatus {
            accelerator: capture.to_string(),
            ok: false,
            error: Some(error.to_string()),
        },
    };
    app.schedule_broadcast();
}

/// Translate an Electron-style accelerator (`Control+Alt+Shift+Space`) into the
/// key code representation used by the global hotkey backend.
pub fn parse_accelerator(accelerator: &str) -> Option<HotKey> {
    let mut modifiers = Modifiers::empty();
    let mut code: Option<Code> = None;
    for raw in accelerator.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        let lower = token.to_lowercase();
        match lower.as_str() {
            "control" | "ctrl" | "cmdorctrl" | "commandorcontrol" | "cmd" | "command" => {
                modifiers |= Modifiers::CONTROL
            }
            "alt" | "option" | "menu" => modifiers |= Modifiers::ALT,
            "shift" => modifiers |= Modifiers::SHIFT,
            "super" | "meta" | "win" | "windows" => modifiers |= Modifiers::SUPER,
            _ => {
                if code.is_some() {
                    return None;
                }
                code = Some(parse_code(&lower)?);
            }
        }
    }
    let code = code?;
    Some(HotKey::new(Some(modifiers), code))
}

fn parse_code(token: &str) -> Option<Code> {
    let named = match token {
        "space" | " " => Some(Code::Space),
        "enter" | "return" => Some(Code::Enter),
        "escape" | "esc" => Some(Code::Escape),
        "tab" => Some(Code::Tab),
        "backspace" => Some(Code::Backspace),
        "delete" | "del" => Some(Code::Delete),
        "insert" | "ins" => Some(Code::Insert),
        "home" => Some(Code::Home),
        "end" => Some(Code::End),
        "pageup" | "pgup" => Some(Code::PageUp),
        "pagedown" | "pgdn" => Some(Code::PageDown),
        "up" | "arrowup" => Some(Code::ArrowUp),
        "down" | "arrowdown" => Some(Code::ArrowDown),
        "left" | "arrowleft" => Some(Code::ArrowLeft),
        "right" | "arrowright" => Some(Code::ArrowRight),
        "plus" | "=" | "equal" => Some(Code::Equal),
        "minus" | "-" => Some(Code::Minus),
        "," | "comma" => Some(Code::Comma),
        "." | "period" => Some(Code::Period),
        "/" | "slash" => Some(Code::Slash),
        "`" | "backquote" => Some(Code::Backquote),
        ";" | "semicolon" => Some(Code::Semicolon),
        "'" | "quote" => Some(Code::Quote),
        "\\" | "backslash" => Some(Code::Backslash),
        "[" | "bracketleft" => Some(Code::BracketLeft),
        "]" | "bracketright" => Some(Code::BracketRight),
        _ => None,
    };
    if named.is_some() {
        return named;
    }
    if token.len() == 1 {
        let ch = token.chars().next()?;
        if ch.is_ascii_alphabetic() {
            return Some(match ch.to_ascii_uppercase() {
                'A' => Code::KeyA,
                'B' => Code::KeyB,
                'C' => Code::KeyC,
                'D' => Code::KeyD,
                'E' => Code::KeyE,
                'F' => Code::KeyF,
                'G' => Code::KeyG,
                'H' => Code::KeyH,
                'I' => Code::KeyI,
                'J' => Code::KeyJ,
                'K' => Code::KeyK,
                'L' => Code::KeyL,
                'M' => Code::KeyM,
                'N' => Code::KeyN,
                'O' => Code::KeyO,
                'P' => Code::KeyP,
                'Q' => Code::KeyQ,
                'R' => Code::KeyR,
                'S' => Code::KeyS,
                'T' => Code::KeyT,
                'U' => Code::KeyU,
                'V' => Code::KeyV,
                'W' => Code::KeyW,
                'X' => Code::KeyX,
                'Y' => Code::KeyY,
                _ => Code::KeyZ,
            });
        }
        if ch.is_ascii_digit() {
            return Some(match ch {
                '0' => Code::Digit0,
                '1' => Code::Digit1,
                '2' => Code::Digit2,
                '3' => Code::Digit3,
                '4' => Code::Digit4,
                '5' => Code::Digit5,
                '6' => Code::Digit6,
                '7' => Code::Digit7,
                '8' => Code::Digit8,
                _ => Code::Digit9,
            });
        }
    }
    if let Some(rest) = token.strip_prefix('f') {
        if let Ok(number) = rest.parse::<u8>() {
            return Some(match number {
                1 => Code::F1,
                2 => Code::F2,
                3 => Code::F3,
                4 => Code::F4,
                5 => Code::F5,
                6 => Code::F6,
                7 => Code::F7,
                8 => Code::F8,
                9 => Code::F9,
                10 => Code::F10,
                11 => Code::F11,
                12 => Code::F12,
                13 => Code::F13,
                14 => Code::F14,
                15 => Code::F15,
                16 => Code::F16,
                17 => Code::F17,
                18 => Code::F18,
                19 => Code::F19,
                20 => Code::F20,
                _ => return None,
            });
        }
    }
    None
}

#[allow(dead_code)]
pub fn receiver_is_empty(receiver: &Receiver<HotkeyCommand>) -> bool {
    receiver.try_recv().is_err()
}
