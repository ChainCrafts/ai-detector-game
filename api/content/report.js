const { dispatch } = require('../_dispatch');

module.exports = async (req, res) => {
  await dispatch(req, res);
};
