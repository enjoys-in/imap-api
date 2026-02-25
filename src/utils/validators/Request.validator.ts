import { body, oneOf, query } from "express-validator";

// Allowed types
const allowedTypes = [
	"create",
	"rename",
	"delete",
	"subscribe",
	"unsubscribe",
	"status",
	"quota",
];

export const UserReqValidator = {
	test: [
		body("phone")
			.isString()
			.isLength({ min: 10, max: 10 })
			.withMessage("Mobile number should be 10 digits")
			.notEmpty()
			.withMessage("Please Provide Mobile Number"),
	],
};

export const validateMailboxOperation = [
	// Validate the `type` query parameter
	query("type")
		.isIn(allowedTypes)
		.withMessage(`type must be one of ${allowedTypes.join(", ")}`),

	// Always require `mailbox` in the body
	body("mailbox")
		.exists({ checkFalsy: true })
		.withMessage("mailbox is required")
		.isString()
		.withMessage("mailbox must be a string")
		.isLength({ min: 3 })
		.withMessage("mailbox must be at least 3 characters long"),

	// Conditionally validate `targetMailbox` if `type` is rename
	oneOf([
		// If type is not rename, skip targetMailbox validation
		query("type")
			.not()
			.equals("rename"),
		// If type is rename, targetMailbox must be present and a string
		[
			body("targetMailbox")
				.exists({ checkFalsy: true })
				.withMessage("targetMailbox is required for rename")
				.isString()
				.withMessage("targetMailbox must be a string"),
		],
	]),
];
