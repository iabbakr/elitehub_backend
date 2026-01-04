const axios = require('axios');

exports.checkTransactionStatus = async (requestId) => {
    try {
        const res = await axios.post(
            `${process.env.VTPASS_BASE_URL}/requery`,
            { request_id: requestId },
            {
                headers: {
                    "api-key": process.env.VTPASS_API_KEY,
                    "secret-key": process.env.VTPASS_SECRET_KEY
                }
            }
        );
        
        // VTPass '000' code means success
        return res.data.code === '000' ? 'success' : 'pending_or_failed';
    } catch (err) {
        return 'error';
    }
};