export function isMintJobSending(job) {
  return job?.status === "sending"
}

export function canChangeMintInputs(job) {
  return !isMintJobSending(job)
}
