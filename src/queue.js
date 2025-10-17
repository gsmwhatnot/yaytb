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
    };
  }

  get stats() {
    return {
      active: this.activeCount,
      queued: this.queue.length,
      concurrency: this.concurrency,
    };
  }

  #runJob(job) {
    this.activeCount += 1;

    Promise.resolve()
      .then(() => job.task())
      .then((value) => {
        job.resolve(value);
      })
      .catch((error) => {
        job.reject(error);
      })
      .finally(() => {
        this.activeCount -= 1;
        const next = this.queue.shift();
        if (next) {
          this.#runJob(next);
        }
      });
  }
}
