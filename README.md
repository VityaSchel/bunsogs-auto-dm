# bunsogs-auto-dm

Automatically greet your new [bunsogs](https://github.com/vityaSchel/bunsogs/) participants by welcoming message! And optionally captcha before giving them messages sending permission.

![Demo](https://github.com/user-attachments/assets/060b478f-4668-4640-9e69-4776ec8cc50d)

## Install

Prerequisite: Install Bun for this plugin. Go to [bun.sh](https://bun.sh), run one line script in your terminal and test it with `bun -v` If it shows version number, you've just installed the best js runtime and ready to install this plugin.

1. Go to your bunsogs directory
2. Open plugins subdirectory
3. Clone this repository there or download as zip and unpack to plugins directory
4. Go into this plugin's directory, run `bun install` and optionally configure plugin
5. Restart your bunsogs

Data is stored in db.json and session_*.json. DO NOT EDIT THESE MANUALLY.

## Configuration

bunsogs-auto-dm allows you to configure message for each room individually via config.json file's `rooms` property where key is room's token. Any changes to config.json require restarting bunsogs.

In each room item add "message" property — which is a string text message that is sent to each user upon joining SOGS inside of that room. It's only visible to new participant. Max length is 1024 characters.

Optionally set "captcha" to true to send user captcha along with greeting message. To control difficulty you can set "captcha_difficult" to true. Optionally set "verified_message" string which is a message sent to user after they complete captcha verification process.

Example configuration:

Assuming you have rooms `my_chat_room` and `my_public_channel_room` and want to send your users greeting messages and verify them with captcha in chat room:

```json
{
  "rooms": {
    "my_chat_room": {
      "message": "Hello! Solve this captcha to be able to send messages in our room!",
      "verified_message": "Thanks! Now you can write",
      "captcha": true,
      "captcha_difficult": false
    }
  }
}
```

## Caveats

These are some edge cases that might help you figure out why this plugin does not work

- bunsogs-auto-dm won't send greetings message or captcha to global or room's admins and moderators
- bunsogs-auto-dm will resend greeting message after 30 days if captcha is enabled, but user wasn't verified and keeps lurking.
- bunsogs-auto-dm won't attempt to send greetings message to users who are banned or who already have write permission set to false specifically to them (modified by sogs admin) — that is to prevent muted users from regaining access to write via this plugin
- users who joined before you set "captcha" to true will have write permissions to chat
- users who joined before you set "captcha" to false will still have to complete captcha before they get access

*P.S. Despite this plugin having "dm" in its name, it has nothing to do with DMs. Initially I was hoping that it could send messages directly to user or at least in SOGS private inbox, but there is no way to convert blinded Session ID to regular Session ID and by default everyone has SOGS inbox messages disabled*