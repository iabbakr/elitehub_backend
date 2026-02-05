/**
 * ✅ catchAsync Utility
 * Wraps asynchronous functions to catch errors and pass them to the 
 * global error handling middleware automatically.
 */
module.exports = (fn) => {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
};