export class DownloadQueue {
  constructor(concurrency = 1) {
    this.concurrency = Math.max(concurrency, 1);
    this.activeCount = 0;
    this.queue = [];
  }

  enqueue(task) {
    const shouldQueue = this.activeCount >= this.concurrency;
    const position = shouldQueue ? this.queue.length + 1 : 0;

    let externalResolve;
    let externalReject;
    const promise = new Promise((resolve, reject) => {
      externalResolve = resolve;
      externalReject = reject;
    });

    const job = {
      task,
      resolve: externalResolve,
      reject: externalReject,
      active: false,
      canceled: false,
    };

    if (shouldQueue) {
      this.queue.push(job);
    } else {
      this.#runJob(job);
    }

    return {
      promise,
      position,
      queued: shouldQueue,
      cancel: () => this.cancel(job),
    };
  }

  cancel(job) {
    if (job.active || job.canceled) {
      return false;
    }

    const index = this.queue.indexOf(job);
    if (index === -1) {
      return false;
    }

    job.canceled = true;
    this.queue.splice(index, 1);
    const error = new Error("Job canceled");
    error.name = "AbortError";
    job.reject(error);
    return true;
  }

  get stats() {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      concurrency: this.concurrency,
    };
  }

  #runJob(job) {
    if (job.canceled) {
      return;
    }

    job.active = true;
    this.activeCount += 1;

    Promise.resolve()
      .then(() => job.task())
      .then(
        (value) => {
          job.result = { ok: true, value };
        },
        (error) => {
          job.result = { ok: false, error };
        }
      )
      .finally(() => {
        this.activeCount -= 1;
        const next = this.queue.shift();
        if (next) {
          this.#runJob(next);
        }

        if (job.result?.ok) {
          job.resolve(job.result.value);
        } else {
          job.reject(job.result?.error || new Error("Job failed"));
        }
      });
  }
}
