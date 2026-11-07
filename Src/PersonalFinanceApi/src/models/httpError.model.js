export default class HttpError extends Error {
  constructor(statusCode, code, message, data, headers) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.data = data;
    this.headers = headers;
  }
}
