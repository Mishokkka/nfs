/** Prepare continuous sounds once, not at each repeat. Trim quiet file padding
 * and overlap the tail with the head into one periodic PCM buffer. Its wrap is
 * between originally adjacent samples, so playback needs no JS seam timer. */
export function prepareLoopBuffer(context, input) {
  const channels = Array.from({ length: input.numberOfChannels }, (_, i) => input.getChannelData(i));
  const block = Math.max(1, Math.round(input.sampleRate * .005));
  const levels = [];
  let peak = 0;
  for (let offset = 0; offset < input.length; offset += block) {
    let energy = 0;
    const count = Math.min(block, input.length - offset);
    for (const channel of channels) for (let i = 0; i < count; i++) energy += channel[offset + i] ** 2;
    const rms = Math.sqrt(energy / (count * channels.length));
    levels.push(rms); peak = Math.max(peak, rms);
  }
  if (peak < 1e-6 || input.length < 16) return input;
  const threshold = peak * .08;
  let first = 0, last = levels.length - 1;
  while (first < last && levels[first] < threshold) first++;
  while (last > first && levels[last] < threshold) last--;
  // Preserve an already periodic recording, including its intended duration.
  // A natural noisy seam need not be quieter than ordinary adjacent samples.
  if (first === 0 && last === levels.length - 1) {
    const span = Math.min(Math.round(input.sampleRate * .04), input.length - 1);
    let jumps = 0, differences = 0, head = 0, tail = 0, energy = 0;
    for (const value of levels) energy += value * value;
    for (const channel of channels) {
      jumps += (channel[0] - channel.at(-1)) ** 2;
      for (let i = 0; i < span; i++) {
        differences += (channel[i + 1] - channel[i]) ** 2 + (channel[input.length - 1 - i] - channel[input.length - 2 - i]) ** 2;
        head += channel[i] ** 2; tail += channel[input.length - 1 - i] ** 2;
      }
    }
    const reference = energy / levels.length;
    if (jumps <= differences / (span * 2) * 2.25 + 1e-12
      && Math.min(head, tail) / (span * channels.length) >= reference * .5) return input;
  }
  const start = first * block;
  let end = Math.min(input.length, (last + 1) * block);
  const overlap = Math.min(Math.round(input.sampleRate * .06), Math.floor((end - start) / 4));
  if (overlap < 2) return input;
  const correlation = candidateEnd => {
    let xy = 0, xx = 0, yy = 0;
    for (const channel of channels) for (let i = 0; i < overlap; i += 4) {
      const x = channel[start + i], y = channel[candidateEnd - overlap + i];
      xy += x * y; xx += x * x; yy += y * y;
    }
    return xy / Math.max(1e-12, Math.sqrt(xx * yy));
  };
  let similarity = correlation(end);
  // Avoid cancelling a tonal engine halfway through the blend. This bounded
  // phase search is performed only for an anti-correlated seam, once at load.
  if (similarity < -.1) {
    const search = Math.min(Math.round(input.sampleRate * .02), end - start - overlap * 3);
    const originalEnd = end;
    for (let candidate = 1; candidate <= 32; candidate++) {
      const candidateEnd = originalEnd - Math.round(search * candidate / 32);
      const score = correlation(candidateEnd);
      if (score > similarity) { similarity = score; end = candidateEnd; }
    }
  }
  const length = end - start - overlap;
  const output = context.createBuffer(channels.length, length, input.sampleRate);
  const shared = Math.max(0, Math.min(1, similarity));
  for (let channel = 0; channel < channels.length; channel++) {
    const source = channels[channel], target = output.getChannelData(channel);
    target.set(source.subarray(start + overlap, end - overlap));
    for (let i = 0; i < overlap; i++) {
      const head = i / (overlap - 1), tail = 1 - head;
      const power = Math.sqrt(head * head + tail * tail + 2 * shared * head * tail);
      target[length - overlap + i] = (source[end - overlap + i] * tail + source[start + i] * head) / power;
    }
  }
  return output;
}
