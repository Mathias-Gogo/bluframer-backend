// Throw this from any route handler for "the request was wrong" problems;
// the error handler turns it into a clean 4xx instead of a generic 500.
export class BadRequestError extends Error {
    constructor(message) {
        super(message);
        this.status = 400;
    }
}