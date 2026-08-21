/**
 * Input translation tables for Android.
 *
 * Our wire protocol speaks USB HID Usage Page 0x07 for keys (PROTOCOL.md §5)
 * and symbolic names for hardware buttons; scrcpy's INJECT_KEYCODE speaks
 * `android.view.KeyEvent` keycodes. This file is that dictionary.
 */

export const AKEYCODE = {
  UNKNOWN: 0,
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  DIGIT_0: 7,
  DIGIT_1: 8,
  STAR: 17,
  POUND: 18,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  A: 29,
  COMMA: 55,
  PERIOD: 56,
  ALT_LEFT: 57,
  SHIFT_LEFT: 59,
  SHIFT_RIGHT: 60,
  TAB: 61,
  SPACE: 62,
  ENTER: 66,
  DEL: 67,
  GRAVE: 68,
  MINUS: 69,
  EQUALS: 70,
  LEFT_BRACKET: 71,
  RIGHT_BRACKET: 72,
  BACKSLASH: 73,
  SEMICOLON: 74,
  APOSTROPHE: 75,
  SLASH: 76,
  MENU: 82,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  ESCAPE: 111,
  FORWARD_DEL: 112,
  CTRL_LEFT: 113,
  CTRL_RIGHT: 114,
  CAPS_LOCK: 115,
  MOVE_HOME: 122,
  MOVE_END: 123,
  INSERT: 124,
  F1: 131,
  APP_SWITCH: 187,
} as const;

/**
 * Button name (PROTOCOL.md §5 buttonId table) -> Android keycode.
 *
 * `lock` maps to POWER because on Android that is the same physical key; the
 * names differ only because the table is shared with iOS.
 */
export const BUTTON_KEYCODE: Readonly<Record<string, number>> = {
  home: AKEYCODE.HOME,
  back: AKEYCODE.BACK,
  app_switch: AKEYCODE.APP_SWITCH,
  power: AKEYCODE.POWER,
  lock: AKEYCODE.POWER,
  volume_up: AKEYCODE.VOLUME_UP,
  volume_down: AKEYCODE.VOLUME_DOWN,
  menu: AKEYCODE.MENU,
  camera: AKEYCODE.CAMERA,
};

/** The subset we advertise in `capabilities.buttons` (ARCHITECTURE.md). */
export const ANDROID_BUTTONS = [
  "back",
  "home",
  "app_switch",
  "power",
  "volume_up",
  "volume_down",
  "menu",
] as const;

const HID_MISC: Readonly<Record<number, number>> = {
  0x28: AKEYCODE.ENTER,
  0x29: AKEYCODE.ESCAPE,
  0x2a: AKEYCODE.DEL, // backspace
  0x2b: AKEYCODE.TAB,
  0x2c: AKEYCODE.SPACE,
  0x2d: AKEYCODE.MINUS,
  0x2e: AKEYCODE.EQUALS,
  0x2f: AKEYCODE.LEFT_BRACKET,
  0x30: AKEYCODE.RIGHT_BRACKET,
  0x31: AKEYCODE.BACKSLASH,
  0x33: AKEYCODE.SEMICOLON,
  0x34: AKEYCODE.APOSTROPHE,
  0x35: AKEYCODE.GRAVE,
  0x36: AKEYCODE.COMMA,
  0x37: AKEYCODE.PERIOD,
  0x38: AKEYCODE.SLASH,
  0x39: AKEYCODE.CAPS_LOCK,
  0x49: AKEYCODE.INSERT,
  0x4a: AKEYCODE.MOVE_HOME,
  0x4b: AKEYCODE.PAGE_UP,
  0x4c: AKEYCODE.FORWARD_DEL,
  0x4d: AKEYCODE.MOVE_END,
  0x4e: AKEYCODE.PAGE_DOWN,
  0x4f: AKEYCODE.DPAD_RIGHT,
  0x50: AKEYCODE.DPAD_LEFT,
  0x51: AKEYCODE.DPAD_DOWN,
  0x52: AKEYCODE.DPAD_UP,
  0xe0: AKEYCODE.CTRL_LEFT,
  0xe1: AKEYCODE.SHIFT_LEFT,
  0xe2: AKEYCODE.ALT_LEFT,
  0xe4: AKEYCODE.CTRL_RIGHT,
  0xe5: AKEYCODE.SHIFT_RIGHT,
};

/**
 * USB HID usage (page 0x07) -> Android keycode, or undefined when we have no
 * equivalent (the caller should then drop the key rather than inject garbage).
 */
export function keycodeForHidUsage(usage: number): number | undefined {
  // a..z are contiguous in both encodings
  if (usage >= 0x04 && usage <= 0x1d) return AKEYCODE.A + (usage - 0x04);
  // HID orders digits 1..9 then 0; Android orders 0..9
  if (usage >= 0x1e && usage <= 0x26) return AKEYCODE.DIGIT_1 + (usage - 0x1e);
  if (usage === 0x27) return AKEYCODE.DIGIT_0;
  if (usage >= 0x3a && usage <= 0x45) return AKEYCODE.F1 + (usage - 0x3a);
  return HID_MISC[usage];
}
