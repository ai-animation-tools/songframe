/** Linux-манифест создаётся внутри готовой поставки, до упаковки её в AppImage. */
module.exports = require('./linux-package.cjs').createInventory;
