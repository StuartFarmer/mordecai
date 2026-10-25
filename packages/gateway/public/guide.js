/* global document, navigator, window, setTimeout */
const feedback = document.getElementById('copy-status');

for (const block of document.querySelectorAll('.command')) {
  const pre = block.querySelector('pre');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-button';
  button.textContent = 'Copy';
  button.setAttribute('aria-label', `Copy ${pre.getAttribute('aria-label')}`);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      button.textContent = 'Copied';
      feedback.textContent = 'Code copied to clipboard.';
    } catch {
      // Plain HTTP peers may not have clipboard access. Leave native copying available.
      pre.focus();
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      button.textContent = 'Select & copy';
      feedback.textContent =
        'Automatic copy unavailable. Use your browser’s Copy command on the code.';
    }
    setTimeout(() => {
      button.textContent = 'Copy';
    }, 2000);
  });
  block.querySelector('.command-label').append(button);
}
