# YoutubeTabCleaner
Chrome Browser Extension that adds all open Youtube video tabs to your watch later list. With an option to close non video tabs as well. Made for TAB HOARDERS like me...

The extension will retry multiple times because the Youtube UI is kind of buggy, else it didnt actually add all videos to watch later.

If some videos are still not getting added to your watch later, increase the retries or delay near the bottom of background.js:

```js
const config = {
  delayOpen: 1600,
  delayClick: 1600,
  delayClose: 1600,
  delayReopen: 1600,
  maxAttempts: 6,
};
```

# Instalation instructions:
Simply download the release, unzip it and add it to your browser extensions with "Load Unpacked" (You need to be in DEV mode for this!)
