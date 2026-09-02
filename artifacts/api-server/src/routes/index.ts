import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { agentsRouter } from "./agents";
import { candidateRouter } from "./candidate";
import authRouter from "./auth";
import recruiterRouter from "./recruiter";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/agents", agentsRouter);
router.use("/candidate", candidateRouter);
router.use("/recruiter", recruiterRouter);

export default router;
