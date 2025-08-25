# YoutubeTabCleaner
Chrome Browser Extension that adds all open Youtube video tabs to your watch later list. With an option to close non video tabs as well. Made for TAB HOARDERS like me...

The extension will retry multiple times because the Youtube UI is kind of buggy, else it didnt actually add all videos to watch later.

If some videos are still not getting added to your watch later, increase the retries or delays near the top & bottom of background.js\
(Change both delays, one is for videos, the other for shorts.):

```js
    delayOpen   = 2474,
    delayClick  = 2474,
    delayClose  = 2474,
    delayReopen = 4747,
    delayReload = 4747,   // wait after a service-worker-triggered reload
    maxAttempts = 7,
    reloadMax   = 3,      // max reloads the SW will do if Shorts UI is missing
};
```

# Installation instructions:
Simply download the release, unzip it and add it to your browser extensions with "Load Unpacked" (You need to be in DEV mode for this!)
