// Paste this in browser console to check gain value
setInterval(() => {
    if (window.State && window.State.gainNode) {
        console.log('🔊 Current gain:', window.State.gainNode.gain.value);
    }
}, 1000);
